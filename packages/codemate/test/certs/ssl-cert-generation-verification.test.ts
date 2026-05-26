import { describe, test, expect } from "bun:test"
import { $ } from "bun"
import { writeFile, readFile, stat, mkdir, access } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "../fixture/fixture"

/**
 * Comprehensive tests for SSL certificate generation and verification.
 *
 * Covers the full lifecycle:
 *   1. RSA key generation with correct permissions
 *   2. Self-signed certificate creation with correct subject fields
 *   3. Combined PEM (key + cert) file creation
 *   4. verification.txt content accuracy
 *   5. Python check_cert.py script execution
 *
 * Each test uses its own tmpdir() for full isolation.
 */

const CHECK_CERT_PY = join(import.meta.dir, "check_cert.py")

const SUBJECT = "/O=DevOps Team/CN=dev-internal.company.local"
const VALIDITY_DAYS = 365

// ─── Helpers ──────────────────────────────────────────────────────────

/** Run an arbitrary command, always returning the result. */
async function sh(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await $`${cmd}`.quiet()
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } catch (err: any) {
    return { exitCode: err.exitCode ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" }
  }
}

interface SslPaths {
  sslDir: string
  keyPath: string
  certPath: string
  pemPath: string
  verifyPath: string
}

/** Generate a full SSL setup in the given base directory. */
async function generateSslSetup(base: string): Promise<SslPaths> {
  const sslDir = join(base, "ssl")
  await mkdir(sslDir, { recursive: true })

  const keyPath = join(sslDir, "server.key")
  const certPath = join(sslDir, "server.crt")
  const pemPath = join(sslDir, "server.pem")
  const verifyPath = join(sslDir, "verification.txt")

  // 1. Generate 2048-bit RSA private key via OpenSSL
  await $`openssl genrsa -out ${keyPath} 2048`
  await $`chmod 600 ${keyPath}`

  // 2. Generate self-signed certificate
  await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

  // 3. Create combined PEM (key + cert)
  const keyContent = await readFile(keyPath, "utf-8")
  const certContent = await readFile(certPath, "utf-8")
  await writeFile(pemPath, keyContent + certContent)

  // 4. Build verification.txt from actual certificate data
  const subjectOut = await $`openssl x509 -in ${certPath} -noout -subject`.text()
  const notBeforeOut = await $`openssl x509 -in ${certPath} -noout -startdate`.text()
  const notAfterOut = await $`openssl x509 -in ${certPath} -noout -enddate`.text()
  const fingerprintOut = await $`openssl x509 -in ${certPath} -noout -fingerprint -sha256`.text()

  const verifyContent = [
    subjectOut.trim(),
    notBeforeOut.trim(),
    notAfterOut.trim(),
    fingerprintOut.trim(),
  ].join("\n")

  await writeFile(verifyPath, verifyContent)

  return { sslDir, keyPath, certPath, pemPath, verifyPath }
}

// ─── 1. Key Generation with Correct Permissions ─────────────────────

describe("1. RSA Key Generation", () => {
  test("generates a 2048-bit RSA private key in PEM format", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")

    await $`openssl genrsa -out ${keyPath} 2048`

    const keyContent = await readFile(keyPath, "utf-8")
    // Accept both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
    expect(keyContent).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
    expect(keyContent).toMatch(/END (RSA )?PRIVATE KEY/)
  })

  test("key has 600 permissions (owner read/write only)", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`chmod 600 ${keyPath}`

    const fileStat = await stat(keyPath)
    const permissions = fileStat.mode & 0o777
    expect(permissions).toBe(0o600)
  })

  test("key is exactly 2048 bits", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")

    await $`openssl genrsa -out ${keyPath} 2048`

    const { stdout } = await $`openssl rsa -in ${keyPath} -text -noout`.quiet()
    expect(stdout.toString()).toContain("2048 bit")
  })

  test("key has a valid PEM private key header (PKCS#1 or PKCS#8)", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")

    await $`openssl genrsa -out ${keyPath} 2048`

    const keyContent = await readFile(keyPath, "utf-8")
    // openssl genrsa produces PKCS#1 (BEGIN RSA PRIVATE KEY) by default;
    // pkcs8 / newpem may produce PKCS#8 (BEGIN PRIVATE KEY). Accept either.
    expect(keyContent).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
    expect(keyContent).toMatch(/END (RSA )?PRIVATE KEY/)
  })
})

// ─── 2. Certificate Creation with Correct Subject Fields ─────────────

describe("2. Self-Signed Certificate Creation", () => {
  test("creates a valid X.509 certificate", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")
    const certPath = join(tmp.path, "server.crt")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

    const certContent = await readFile(certPath, "utf-8")
    expect(certContent).toContain("BEGIN CERTIFICATE")
    expect(certContent).toContain("END CERTIFICATE")
  })

  test("subject contains O=DevOps Team", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")
    const certPath = join(tmp.path, "server.crt")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

    const { stdout } = await $`openssl x509 -in ${certPath} -noout -subject`.quiet()
    expect(stdout.toString()).toContain("O=DevOps Team")
  })

  test("subject contains CN=dev-internal.company.local", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")
    const certPath = join(tmp.path, "server.crt")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

    const { stdout } = await $`openssl x509 -in ${certPath} -noout -subject`.quiet()
    expect(stdout.toString()).toContain("CN=dev-internal.company.local")
  })

  test("certificate is self-signed (issuer equals subject)", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")
    const certPath = join(tmp.path, "server.crt")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

    const issuerOut = (await $`openssl x509 -in ${certPath} -noout -issuer`.quiet()).stdout.toString()
    const subjectOut = (await $`openssl x509 -in ${certPath} -noout -subject`.quiet()).stdout.toString()

    const issuer = issuerOut.replace("issuer=", "").trim()
    const subject = subjectOut.replace("subject=", "").trim()
    expect(issuer).toBe(subject)
  })

  test("certificate is valid for approximately 365 days", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")
    const certPath = join(tmp.path, "server.crt")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

    const notBefore = (await $`openssl x509 -in ${certPath} -noout -startdate`.quiet()).stdout.toString()
    const notAfter = (await $`openssl x509 -in ${certPath} -noout -enddate`.quiet()).stdout.toString()

    const startDate = new Date(notBefore.replace("notBefore=", ""))
    const endDate = new Date(notAfter.replace("notAfter=", ""))

    const diffDays = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeGreaterThanOrEqual(364)
    expect(diffDays).toBeLessThanOrEqual(366)
  })

  test("certificate has not expired", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")
    const certPath = join(tmp.path, "server.crt")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

    const result = await $`openssl x509 -in ${certPath} -noout -checkend 0`.quiet()
    expect(result.exitCode).toBe(0)
  })

  test("certificate uses SHA-256 signature algorithm", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")
    const certPath = join(tmp.path, "server.crt")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

    const { stdout } = await $`openssl x509 -in ${certPath} -noout -text`.quiet()
    expect(stdout.toString()).toContain("sha256")
  })

  test("certificate public key is 2048-bit RSA", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")
    const certPath = join(tmp.path, "server.crt")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

    const { stdout } = await $`openssl x509 -in ${certPath} -noout -text`.quiet()
    expect(stdout.toString()).toContain("2048 bit")
  })

  test("key and certificate share the same RSA modulus", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")
    const certPath = join(tmp.path, "server.crt")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

    const keyModulus = (await $`openssl rsa -in ${keyPath} -modulus -noout`.quiet()).stdout.toString().trim()
    const certModulus = (await $`openssl x509 -in ${certPath} -modulus -noout`.quiet()).stdout.toString().trim()
    expect(keyModulus).toBe(certModulus)
  })
})

// ─── 3. Combined PEM File Creation ──────────────────────────────────

describe("3. Combined PEM (server.pem)", () => {
  test("combined PEM contains the private key", async () => {
    await using tmp = await tmpdir()
    const { pemPath } = await generateSslSetup(tmp.path)

    const pem = await readFile(pemPath, "utf-8")
    // Accept both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
    expect(pem).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
    expect(pem).toMatch(/END (RSA )?PRIVATE KEY/)
  })

  test("combined PEM contains the certificate", async () => {
    await using tmp = await tmpdir()
    const { pemPath } = await generateSslSetup(tmp.path)

    const pem = await readFile(pemPath, "utf-8")
    expect(pem).toContain("BEGIN CERTIFICATE")
    expect(pem).toContain("END CERTIFICATE")
  })

  test("private key appears before certificate in combined PEM", async () => {
    await using tmp = await tmpdir()
    const { pemPath } = await generateSslSetup(tmp.path)

    const pem = await readFile(pemPath, "utf-8")
    // Accept both PKCS#8 and PKCS#1 key headers for finding the key position
    const pkcs8Idx = pem.indexOf("BEGIN PRIVATE KEY")
    const pkcs1Idx = pem.indexOf("BEGIN RSA PRIVATE KEY")
    const keyIdx = pkcs1Idx >= 0 ? pkcs1Idx : pkcs8Idx
    const certIdx = pem.indexOf("BEGIN CERTIFICATE")
    expect(keyIdx).toBeGreaterThanOrEqual(0)
    expect(keyIdx).toBeLessThan(certIdx)
  })

  test("key and cert in combined PEM share the same RSA modulus", async () => {
    await using tmp = await tmpdir()
    const { pemPath } = await generateSslSetup(tmp.path)

    const keyModulus = (await $`openssl rsa -in ${pemPath} -modulus -noout 2>/dev/null`.quiet()).stdout.toString().trim()
    const certModulus = (await $`openssl x509 -in ${pemPath} -modulus -noout 2>/dev/null`.quiet()).stdout.toString().trim()
    expect(keyModulus).toBe(certModulus)
  })

  test("openssl can parse the certificate from the combined PEM", async () => {
    await using tmp = await tmpdir()
    const { pemPath } = await generateSslSetup(tmp.path)

    const { stdout } = await $`openssl x509 -in ${pemPath} -noout -subject`.quiet()
    expect(stdout.toString()).toContain("subject=")
  })
})

// ─── 4. verification.txt Content Accuracy ────────────────────────────

describe("4. verification.txt Content Accuracy", () => {
  test("file exists", async () => {
    await using tmp = await tmpdir()
    const { verifyPath } = await generateSslSetup(tmp.path)

    await access(verifyPath)
    const fileStat = await stat(verifyPath)
    expect(fileStat.isFile()).toBe(true)
  })

  test("contains exactly 4 lines (subject, start, end, fingerprint)", async () => {
    await using tmp = await tmpdir()
    const { verifyPath } = await generateSslSetup(tmp.path)

    const content = await readFile(verifyPath, "utf-8")
    const lines = content.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(4)
  })

  test("first line is the certificate subject with expected O and CN", async () => {
    await using tmp = await tmpdir()
    const { verifyPath } = await generateSslSetup(tmp.path)

    const content = await readFile(verifyPath, "utf-8")
    const firstLine = content.split("\n")[0]
    expect(firstLine).toContain("subject=")
    expect(firstLine).toContain("O=DevOps Team")
    expect(firstLine).toContain("CN=dev-internal.company.local")
  })

  test("contains validity start date (notBefore)", async () => {
    await using tmp = await tmpdir()
    const { verifyPath } = await generateSslSetup(tmp.path)

    const content = await readFile(verifyPath, "utf-8")
    expect(content).toContain("notBefore=")
  })

  test("contains validity end date (notAfter)", async () => {
    await using tmp = await tmpdir()
    const { verifyPath } = await generateSslSetup(tmp.path)

    const content = await readFile(verifyPath, "utf-8")
    expect(content).toContain("notAfter=")
  })

  test("contains a valid SHA-256 fingerprint (64 hex chars with colons)", async () => {
    await using tmp = await tmpdir()
    const { verifyPath } = await generateSslSetup(tmp.path)

    const content = await readFile(verifyPath, "utf-8")
    expect(content).toContain("sha256 Fingerprint")
    const fingerprintMatch = content.match(/([0-9A-F]{2}:){31}[0-9A-F]{2}/i)
    expect(fingerprintMatch).not.toBeNull()
  })

  test("SHA-256 fingerprint matches the actual certificate", async () => {
    await using tmp = await tmpdir()
    const { certPath, verifyPath } = await generateSslSetup(tmp.path)

    const content = await readFile(verifyPath, "utf-8")
    const actualFingerprint = (await $`openssl x509 -in ${certPath} -noout -fingerprint -sha256`.quiet())
      .stdout.toString()
      .trim()
    expect(content.trim()).toContain(actualFingerprint)
  })

  test("notBefore date is not in the future", async () => {
    await using tmp = await tmpdir()
    const { verifyPath } = await generateSslSetup(tmp.path)

    const content = await readFile(verifyPath, "utf-8")
    const match = content.match(/notBefore=(.+)/)
    expect(match).not.toBeNull()

    const startDate = new Date(match![1].trim())
    expect(startDate.getTime()).toBeLessThanOrEqual(Date.now())
  })

  test("notAfter date is approximately 365 days from now", async () => {
    await using tmp = await tmpdir()
    const { verifyPath } = await generateSslSetup(tmp.path)

    const content = await readFile(verifyPath, "utf-8")
    const match = content.match(/notAfter=(.+)/)
    expect(match).not.toBeNull()

    const endDate = new Date(match![1].trim())
    const diffDays = (endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeGreaterThanOrEqual(364)
    expect(diffDays).toBeLessThanOrEqual(366)
  })
})

// ─── 5. Python check_cert.py Script Execution ───────────────────────

describe("5. Python check_cert.py Script", () => {
  test("script exists and is readable", async () => {
    const fileStat = await stat(CHECK_CERT_PY)
    expect(fileStat.isFile()).toBe(true)
  })

  test("script has a shebang line", async () => {
    const content = await readFile(CHECK_CERT_PY, "utf-8")
    const firstLine = content.split("\n")[0]
    expect(firstLine).toContain("#!/usr/bin/env python3")
  })

  test("exits with code 0 for a valid certificate", async () => {
    await using tmp = await tmpdir()
    const { certPath } = await generateSslSetup(tmp.path)

    const result = await $`python3 ${CHECK_CERT_PY} ${certPath}`.quiet()
    expect(result.exitCode).toBe(0)
  })

  test("prints Common Name matching the certificate subject", async () => {
    await using tmp = await tmpdir()
    const { certPath } = await generateSslSetup(tmp.path)

    const result = await $`python3 ${CHECK_CERT_PY} ${certPath}`.quiet()
    const output = result.stdout.toString()
    expect(output).toContain("Common Name: dev-internal.company.local")
  })

  test("prints expiration date in YYYY-MM-DD format", async () => {
    await using tmp = await tmpdir()
    const { certPath } = await generateSslSetup(tmp.path)

    const result = await $`python3 ${CHECK_CERT_PY} ${certPath}`.quiet()
    const output = result.stdout.toString()
    const dateMatch = output.match(/Expiration Date: (\d{4}-\d{2}-\d{2})/)
    expect(dateMatch).not.toBeNull()

    const [year, month, day] = dateMatch![1].split("-").map(Number)
    expect(year).toBeGreaterThanOrEqual(2025)
    expect(month).toBeGreaterThanOrEqual(1)
    expect(month).toBeLessThanOrEqual(12)
    expect(day).toBeGreaterThanOrEqual(1)
    expect(day).toBeLessThanOrEqual(31)
  })

  test("prints 'Certificate verification successful' for valid cert", async () => {
    await using tmp = await tmpdir()
    const { certPath } = await generateSslSetup(tmp.path)

    const result = await $`python3 ${CHECK_CERT_PY} ${certPath}`.quiet()
    const output = result.stdout.toString()
    expect(output).toContain("Certificate verification successful")
  })

  test("output has exactly 3 lines (CN, expiration, success)", async () => {
    await using tmp = await tmpdir()
    const { certPath } = await generateSslSetup(tmp.path)

    const result = await $`python3 ${CHECK_CERT_PY} ${certPath}`.quiet()
    const lines = result.stdout
      .toString()
      .split("\n")
      .filter((l: string) => l.trim().length > 0)
    expect(lines.length).toBe(3)
    expect(lines[0]).toMatch(/^Common Name: /)
    expect(lines[1]).toMatch(/^Expiration Date: /)
    expect(lines[2]).toBe("Certificate verification successful")
  })

  test("exits with code 1 when no arguments are provided", async () => {
    const result = await $`python3 ${CHECK_CERT_PY}`.quiet().catch((err) => err)
    expect(result.exitCode).toBe(1)
  })

  test("prints usage message when no arguments are provided", async () => {
    const result = await $`python3 ${CHECK_CERT_PY}`.quiet().catch((err) => err)
    expect(result.stderr.toString()).toContain("Usage:")
  })

  test("exits with error for a non-existent file", async () => {
    const result = await $`python3 ${CHECK_CERT_PY} /tmp/nonexistent-cert.pem`.quiet().catch((err) => err)
    expect(result.exitCode).not.toBe(0)
  })

  test("exits with error for an invalid certificate file", async () => {
    await using tmp = await tmpdir()
    const badPath = join(tmp.path, "bad.pem")
    await writeFile(badPath, "this is not a certificate")

    const result = await $`python3 ${CHECK_CERT_PY} ${badPath}`.quiet().catch((err) => err)
    expect(result.exitCode).not.toBe(0)
  })

  test("works with a certificate having a different CN", async () => {
    await using tmp = await tmpdir()
    const keyPath = join(tmp.path, "server.key")
    const certPath = join(tmp.path, "server.crt")

    await $`openssl genrsa -out ${keyPath} 2048`
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days 90 -subj "/CN=custom-host.example.org"`

    const result = await $`python3 ${CHECK_CERT_PY} ${certPath}`.quiet()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("Common Name: custom-host.example.org")
  })
})
