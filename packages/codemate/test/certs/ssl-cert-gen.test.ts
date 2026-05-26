import { describe, test, expect, beforeAll } from "bun:test"
import { $ } from "bun"
import { mkdir, readFile, stat, writeFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "../fixture/fixture"

const SSL_DIR = "ssl"
const KEY_FILE = "server.key"
const CERT_FILE = "server.crt"
const PEM_FILE = "server.pem"
const VERIFY_FILE = "verification.txt"
const VALIDITY_DAYS = 365

/**
 * Full end-to-end SSL certificate generation using OpenSSL.
 *
 * Creates /app/ssl/ directory and generates:
 *   - server.key  (2048-bit RSA, mode 0600)
 *   - server.crt  (self-signed, 365-day validity)
 *   - server.pem  (key + cert combined)
 *   - verification.txt (subject, validity dates, SHA-256 fingerprint)
 */
async function generateSslCert(base: string) {
  const sslDir = join(base, SSL_DIR)
  await mkdir(sslDir, { recursive: true })

  const keyPath = join(sslDir, KEY_FILE)
  const certPath = join(sslDir, CERT_FILE)
  const pemPath = join(sslDir, PEM_FILE)
  const verifyPath = join(sslDir, VERIFY_FILE)

  // 1. Generate 2048-bit RSA private key
  await $`openssl genrsa -out ${keyPath} 2048`

  // 2. Set 600 permissions on the key
  await chmod(keyPath, 0o600)

  // 3. Generate self-signed certificate with specific subject
  await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj /O=DevOps\ Team/CN=dev-internal.company.local`

  // 4. Combine key + cert into server.pem
  const keyContent = await readFile(keyPath, "utf-8")
  const certContent = await readFile(certPath, "utf-8")
  await writeFile(pemPath, keyContent + certContent)

  // 5. Generate verification.txt
  const subjectOut = await $`openssl x509 -in ${certPath} -noout -subject`.text()
  const notBeforeOut = await $`openssl x509 -in ${certPath} -noout -startdate`.text()
  const notAfterOut = await $`openssl x509 -in ${certPath} -noout -enddate`.text()
  const fingerprintOut = await $`openssl x509 -in ${certPath} -noout -fingerprint -sha256`.text()

  const verifyContent = [subjectOut.trim(), notBeforeOut.trim(), notAfterOut.trim(), fingerprintOut.trim()].join(
    "\n",
  )
  await writeFile(verifyPath, verifyContent)

  return { sslDir, keyPath, certPath, pemPath, verifyPath }
}

describe("SSL Certificate Generation (end-to-end)", () => {
  let rootTmpDir: string
  let paths: Awaited<ReturnType<typeof generateSslCert>>

  beforeAll(async () => {
    const tmp = await tmpdir()
    rootTmpDir = tmp.path
    paths = await generateSslCert(rootTmpDir)
  })

  // ── Directory ───────────────────────────────────────────────────────

  describe("1. /app/ssl/ directory creation", () => {
    test("ssl directory exists and is a directory", async () => {
      const dirStat = await stat(paths.sslDir)
      expect(dirStat.isDirectory()).toBe(true)
    })

    test("ssl directory is inside the base path", () => {
      expect(paths.sslDir).toContain(SSL_DIR)
    })
  })

  // ── Private key ─────────────────────────────────────────────────────

  describe("2. server.key — 2048-bit RSA private key", () => {
    test("file exists", async () => {
      const keyStat = await stat(paths.keyPath)
      expect(keyStat.isFile()).toBe(true)
    })

    test("file permissions are 0600 (owner read/write only)", async () => {
      const keyStat = await stat(paths.keyPath)
      const permissions = keyStat.mode & 0o777
      expect(permissions).toBe(0o600)
    })

    test("file name is server.key", () => {
      expect(paths.keyPath).toEndWith(KEY_FILE)
    })

    test("contains valid PEM-encoded RSA private key", async () => {
      const key = await readFile(paths.keyPath, "utf-8")
      // Accept both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
      expect(key).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
      expect(key).toMatch(/END (RSA )?PRIVATE KEY/)
    })

    test("key size is exactly 2048 bits", async () => {
      const textOut = await $`openssl rsa -in ${paths.keyPath} -text -noout 2>/dev/null | head -1`.text()
      expect(textOut).toContain("2048 bit")
    })
  })

  // ── Self-signed certificate ─────────────────────────────────────────

  describe("3. server.crt — self-signed certificate", () => {
    test("file exists", async () => {
      const certStat = await stat(paths.certPath)
      expect(certStat.isFile()).toBe(true)
    })

    test("file name is server.crt", () => {
      expect(paths.certPath).toEndWith(CERT_FILE)
    })

    test("contains valid PEM-encoded X.509 certificate", async () => {
      const cert = await readFile(paths.certPath, "utf-8")
      expect(cert).toContain("BEGIN CERTIFICATE")
      expect(cert).toContain("END CERTIFICATE")
    })

    test("subject contains O=DevOps Team", async () => {
      const subjectOut = await $`openssl x509 -in ${paths.certPath} -noout -subject`.text()
      expect(subjectOut).toContain("O=DevOps Team")
    })

    test("subject contains CN=dev-internal.company.local", async () => {
      const subjectOut = await $`openssl x509 -in ${paths.certPath} -noout -subject`.text()
      expect(subjectOut).toContain("CN=dev-internal.company.local")
    })

    test("certificate is self-signed (issuer equals subject)", async () => {
      const issuerOut = await $`openssl x509 -in ${paths.certPath} -noout -issuer`.text()
      const subjectOut = await $`openssl x509 -in ${paths.certPath} -noout -subject`.text()
      const issuer = issuerOut.replace("issuer=", "").trim()
      const subject = subjectOut.replace("subject=", "").trim()
      expect(issuer).toBe(subject)
    })

    test("validity is approximately 365 days", async () => {
      const notBeforeOut = await $`openssl x509 -in ${paths.certPath} -noout -startdate`.text()
      const notAfterOut = await $`openssl x509 -in ${paths.certPath} -noout -enddate`.text()

      const startDate = new Date(notBeforeOut.replace("notBefore=", ""))
      const endDate = new Date(notAfterOut.replace("notAfter=", ""))

      const diffMs = endDate.getTime() - startDate.getTime()
      const diffDays = diffMs / (1000 * 60 * 60 * 24)

      expect(diffDays).toBeGreaterThanOrEqual(364)
      expect(diffDays).toBeLessThanOrEqual(366)
    })

    test("certificate has not expired yet", async () => {
      const now = Date.now()
      const notBeforeOut = await $`openssl x509 -in ${paths.certPath} -noout -startdate`.text()
      const notAfterOut = await $`openssl x509 -in ${paths.certPath} -noout -enddate`.text()

      const startDate = new Date(notBeforeOut.replace("notBefore=", "")).getTime()
      const endDate = new Date(notAfterOut.replace("notAfter=", "")).getTime()

      expect(now).toBeGreaterThanOrEqual(startDate)
      expect(now).toBeLessThanOrEqual(endDate)
    })

    test("certificate uses SHA-256 signature algorithm", async () => {
      const sigAlg = await $`openssl x509 -in ${paths.certPath} -noout -text 2>/dev/null | grep "Signature Algorithm:" | head -1`.text()
      expect(sigAlg).toContain("sha256")
    })

    test("public key is 2048-bit RSA", async () => {
      const keyBits = await $`openssl x509 -in ${paths.certPath} -noout -text 2>/dev/null | grep "Public-Key:"`.text()
      expect(keyBits).toContain("2048 bit")
    })
  })

  // ── Combined PEM ────────────────────────────────────────────────────

  describe("4. server.pem — combined key + cert", () => {
    test("file exists", async () => {
      const pemStat = await stat(paths.pemPath)
      expect(pemStat.isFile()).toBe(true)
    })

    test("file name is server.pem", () => {
      expect(paths.pemPath).toEndWith(PEM_FILE)
    })

    test("contains the private key", async () => {
      const pem = await readFile(paths.pemPath, "utf-8")
      // Accept both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
      expect(pem).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
      expect(pem).toMatch(/END (RSA )?PRIVATE KEY/)
    })

    test("contains the certificate", async () => {
      const pem = await readFile(paths.pemPath, "utf-8")
      expect(pem).toContain("BEGIN CERTIFICATE")
      expect(pem).toContain("END CERTIFICATE")
    })

    test("private key appears before certificate", async () => {
      const pem = await readFile(paths.pemPath, "utf-8")
      // Accept both PKCS#8 and PKCS#1 key headers for finding the key position
      const pkcs8Idx = pem.indexOf("BEGIN PRIVATE KEY")
      const pkcs1Idx = pem.indexOf("BEGIN RSA PRIVATE KEY")
      const keyIdx = pkcs1Idx >= 0 ? pkcs1Idx : pkcs8Idx
      const certIdx = pem.indexOf("BEGIN CERTIFICATE")
      expect(keyIdx).toBeGreaterThanOrEqual(0)
      expect(keyIdx).toBeLessThan(certIdx)
    })

    test("key and cert share the same modulus (matching pair)", async () => {
      const keyModulus = await $`openssl rsa -in ${paths.pemPath} -modulus -noout 2>/dev/null`.text()
      const certModulus = await $`openssl x509 -in ${paths.pemPath} -modulus -noout 2>/dev/null`.text()
      expect(keyModulus.trim()).toBe(certModulus.trim())
    })
  })

  // ── verification.txt ────────────────────────────────────────────────

  describe("5. verification.txt — metadata and fingerprint", () => {
    let verifyContent: string

    beforeAll(async () => {
      verifyContent = await readFile(paths.verifyPath, "utf-8")
    })

    test("file exists", async () => {
      const vStat = await stat(paths.verifyPath)
      expect(vStat.isFile()).toBe(true)
    })

    test("file name is verification.txt", () => {
      expect(paths.verifyPath).toEndWith(VERIFY_FILE)
    })

    test("contains the certificate subject", () => {
      expect(verifyContent).toContain("subject=")
      expect(verifyContent).toContain("O=DevOps Team")
      expect(verifyContent).toContain("CN=dev-internal.company.local")
    })

    test("contains the validity start date (notBefore)", () => {
      expect(verifyContent).toContain("notBefore=")
    })

    test("contains the validity end date (notAfter)", () => {
      expect(verifyContent).toContain("notAfter=")
    })

    test("contains a SHA-256 fingerprint", () => {
      expect(verifyContent).toContain("sha256 Fingerprint")
      // SHA-256 fingerprint is 32 bytes = 64 hex chars separated by colons
      const fingerprintMatch = verifyContent.match(/([0-9A-F]{2}:){31}[0-9A-F]{2}/i)
      expect(fingerprintMatch).not.toBeNull()
    })

    test("SHA-256 fingerprint matches the actual certificate fingerprint", async () => {
      const actualFingerprint = await $`openssl x509 -in ${paths.certPath} -noout -fingerprint -sha256`.text()
      expect(verifyContent.trim()).toContain(actualFingerprint.trim())
    })

    test("has exactly 4 lines (subject, notBefore, notAfter, fingerprint)", () => {
      const lines = verifyContent.split("\n").filter((l) => l.length > 0)
      expect(lines.length).toBe(4)
    })
  })

  // ── Integrity ───────────────────────────────────────────────────────

  describe("6. Full roundtrip integrity", () => {
    test("key, cert, and PEM all share the same RSA modulus", async () => {
      const keyModulus = await $`openssl rsa -in ${paths.keyPath} -modulus -noout 2>/dev/null`.text()
      const certModulus = await $`openssl x509 -in ${paths.certPath} -modulus -noout 2>/dev/null`.text()
      const pemModulus = await $`openssl rsa -in ${paths.pemPath} -modulus -noout 2>/dev/null`.text()

      expect(keyModulus.trim()).toBe(certModulus.trim())
      expect(certModulus.trim()).toBe(pemModulus.trim())
    })

    test("private key can produce signatures verified by the certificate public key", async () => {
      const signTmp = join(rootTmpDir, "test-sign.bin")
      const pubTmp = join(rootTmpDir, "test-pub.pem")
      const dataTmp = join(rootTmpDir, "test-data.txt")

      await writeFile(dataTmp, "hello-cert-gen-test")

      // Sign with private key
      await $`openssl dgst -sha256 -sign ${paths.keyPath} -out ${signTmp} ${dataTmp}`

      // Extract public key from certificate
      await $`openssl x509 -in ${paths.certPath} -pubkey -noout -out ${pubTmp}`

      // Verify the signature
      const verifyResult = await $`openssl dgst -sha256 -verify ${pubTmp} -signature ${signTmp} ${dataTmp} 2>&1`.text()
      expect(verifyResult).toContain("Verified OK")
    })

    test("combined PEM can be parsed by OpenSSL as a valid TLS pair", async () => {
      const result = await $`openssl x509 -in ${paths.pemPath} -noout -subject 2>&1`.text()
      expect(result).toContain("subject=")
      expect(result).toContain("CN=dev-internal.company.local")
    })

    test("certificate serializes to DER correctly", async () => {
      const derPath = join(rootTmpDir, "test-cert.der")
      await $`openssl x509 -in ${paths.certPath} -outform DER -out ${derPath}`
      const derStat = await stat(derPath)
      expect(derStat.isFile()).toBe(true)
      expect(derStat.size).toBeGreaterThan(0)
    })

    test("verification.txt dates are consistent with the actual certificate dates", async () => {
      const notBeforeOut = await $`openssl x509 -in ${paths.certPath} -noout -startdate`.text()
      const notAfterOut = await $`openssl x509 -in ${paths.certPath} -noout -enddate`.text()
      const content = await readFile(paths.verifyPath, "utf-8")

      expect(content).toContain(notBeforeOut.trim())
      expect(content).toContain(notAfterOut.trim())
    })
  })
})
