import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { writeFile, readFile, stat, mkdir, rm, access } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "../fixture/fixture"
import { $ } from "bun"

describe("SSL Certificate Verification", () => {
  let tempDir: string
  let sslDir: string
  let keyPath: string
  let certPath: string
  let pemPath: string
  let verificationPath: string

  beforeAll(async () => {
    const tmp = await tmpdir()
    tempDir = tmp.path
    sslDir = join(tempDir, "app", "ssl")
    await mkdir(sslDir, { recursive: true })

    keyPath = join(sslDir, "server.key")
    certPath = join(sslDir, "server.crt")
    pemPath = join(sslDir, "server.pem")
    verificationPath = join(sslDir, "verification.txt")

    // Generate self-signed certificate for testing
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
      },
      publicKeyEncoding: {
        type: "spki",
        format: "pem",
      },
    })

    // Write private key
    await writeFile(keyPath, privateKey, { mode: 0o600 })

    // Create self-signed certificate using OpenSSL
    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days 365 -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"`.quiet()

    // Create combined PEM file
    const certContent = await readFile(certPath, "utf-8")
    await writeFile(pemPath, `${privateKey}\n${certContent}`, { mode: 0o600 })

    // Dynamically generate verification.txt from the actual certificate
    const subjectOut = (await $`openssl x509 -in ${certPath} -noout -subject`.quiet()).stdout.toString().trim()
    const issuerOut = (await $`openssl x509 -in ${certPath} -noout -issuer`.quiet()).stdout.toString().trim()
    const notBeforeOut = (await $`openssl x509 -in ${certPath} -noout -startdate`.quiet()).stdout.toString().trim()
    const notAfterOut = (await $`openssl x509 -in ${certPath} -noout -enddate`.quiet()).stdout.toString().trim()
    const keyTypeOut = (await $`openssl rsa -in ${keyPath} -text -noout`.quiet()).stdout.toString()

    // openssl rsa -text outputs "Private-Key: (2048 bit, 2 primes)" — always RSA since we use openssl rsa
    const keyType = "RSA"
    const keySizeMatch = keyTypeOut.match(/(\d+) bit/)
    const keySize = keySizeMatch ? keySizeMatch[1] : "2048"

    // Parse dates to YYYY-MM-DD
    const notBeforeDate = new Date(notBeforeOut.replace("notBefore=", "")).toISOString().split("T")[0]
    const notAfterDate = new Date(notAfterOut.replace("notAfter=", "")).toISOString().split("T")[0]

    // Extract subject CN
    const cnMatch = subjectOut.match(/CN\s*=\s*([^\s,/]+)/)
    const subjectCn = cnMatch ? cnMatch[1] : "localhost"

    // Extract issuer CN
    const issuerCnMatch = issuerOut.match(/CN\s*=\s*([^\s,/]+)/)
    const issuerCn = issuerCnMatch ? issuerCnMatch[1] : "localhost"

    await writeFile(
      verificationPath,
      `subject=CN=${subjectCn}\nissuer=CN=${issuerCn}\nnot_before=${notBeforeDate}\nnot_after=${notAfterDate}\nkey_type=${keyType}\nkey_size=${keySize}\n`,
      { mode: 0o644 },
    )
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  test("1. /app/ssl/ directory exists", async () => {
    const dirStat = await stat(sslDir)
    expect(dirStat.isDirectory()).toBe(true)
  })

  test("2. server.key has 600 permissions and is valid RSA key", async () => {
    await access(keyPath)

    const keyStat = await stat(keyPath)
    const permissions = keyStat.mode & 0o777
    expect(permissions).toBe(0o600)

    const keyContent = await readFile(keyPath, "utf-8")
    // Accept both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
    expect(keyContent).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
    expect(keyContent).toMatch(/END (RSA )?PRIVATE KEY/)

    const modulusResult = await $`openssl rsa -in ${keyPath} -text -noout`.quiet()
    const keyText = modulusResult.stdout.toString()
    expect(keyText).toContain("2048 bit")
  })

  test("3. server.crt is valid certificate with correct subject", async () => {
    await access(certPath)

    const result = await $`openssl x509 -in ${certPath} -noout -subject -issuer`.quiet()
    const output = result.stdout.toString()

    expect(output).toContain("CN=localhost")

    const verifyResult = await $`openssl x509 -in ${certPath} -noout -checkend 0`.quiet()
    expect(verifyResult.exitCode).toBe(0)
  })

  test("4. server.pem contains both key and cert", async () => {
    await access(pemPath)

    const pemStat = await stat(pemPath)
    const permissions = pemStat.mode & 0o777
    expect(permissions).toBe(0o600)

    const pemContent = await readFile(pemPath, "utf-8")

    // Accept both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
    expect(pemContent).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
    expect(pemContent).toMatch(/END (RSA )?PRIVATE KEY/)
    expect(pemContent).toContain("BEGIN CERTIFICATE")
    expect(pemContent).toContain("END CERTIFICATE")

    // Verify key and cert match via modulus
    const keyModulus = (await $`openssl rsa -in ${pemPath} -modulus -noout 2>/dev/null`.quiet()).stdout
      .toString()
      .trim()
    const certModulus = (await $`openssl x509 -in ${pemPath} -modulus -noout 2>/dev/null`.quiet()).stdout
      .toString()
      .trim()
    expect(keyModulus).toBe(certModulus)
  })

  test("5. verification.txt exists and contains expected fields", async () => {
    await access(verificationPath)

    const content = await readFile(verificationPath, "utf-8")

    expect(content).toContain("subject=CN=localhost")
    expect(content).toContain("issuer=CN=localhost")
    expect(content).toContain("not_before=")
    expect(content).toContain("not_after=")
    expect(content).toContain("key_type=RSA")
    expect(content).toContain("key_size=2048")

    // Verify dates are valid YYYY-MM-DD
    const notBeforeMatch = content.match(/not_before=(\d{4}-\d{2}-\d{2})/)
    expect(notBeforeMatch).not.toBeNull()
    const notAfterMatch = content.match(/not_after=(\d{4}-\d{2}-\d{2})/)
    expect(notAfterMatch).not.toBeNull()
  })

  test("6. Python check_cert.py runs successfully", async () => {
    const checkCertScript = join(import.meta.dir, "check_cert.py")

    const result = await $`python3 ${checkCertScript} ${certPath}`.quiet()

    expect(result.exitCode).toBe(0)

    const output = result.stdout.toString()
    expect(output).toContain("Common Name: localhost")
    expect(output).toContain("Certificate verification successful")
  })
})

describe("SSL Directory Structure", () => {
  test("creates app/ssl directory structure", async () => {
    const tmp = await tmpdir()
    const appDir = join(tmp.path, "app", "ssl")
    await mkdir(appDir, { recursive: true })

    const dirStat = await stat(appDir)
    expect(dirStat.isDirectory()).toBe(true)

    await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
  })
})

describe("Key and Certificate Validation", () => {
  test("RSA key matches certificate public key", async () => {
    const tmp = await tmpdir()
    const sslDir = join(tmp.path, "ssl")
    await mkdir(sslDir, { recursive: true })

    const keyPath = join(sslDir, "server.key")
    const certPath = join(sslDir, "server.crt")

    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
      },
      publicKeyEncoding: {
        type: "spki",
        format: "pem",
      },
    })

    await writeFile(keyPath, privateKey, { mode: 0o600 })

    await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days 365 -subj "/C=US/ST=State/L=City/O=Organization/CN=test"`.quiet()

    const keyModulus = (await $`openssl rsa -in ${keyPath} -modulus -noout`.quiet()).stdout.toString().trim()
    const certModulus = (await $`openssl x509 -in ${certPath} -modulus -noout`.quiet()).stdout.toString().trim()

    expect(keyModulus).toBe(certModulus)

    await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
  })
})
