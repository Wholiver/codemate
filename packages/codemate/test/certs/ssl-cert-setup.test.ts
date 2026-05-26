import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { $ } from "bun"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "../fixture/fixture"

const SSL_DIR = "ssl"
const KEY_FILE = "server.key"
const CERT_FILE = "server.crt"
const PEM_FILE = "server.pem"
const VERIFY_FILE = "verification.txt"
const SUBJECT = "/O=DevOps Team/CN=dev-internal.company.local"
const VALIDITY_DAYS = 365

/**
 * Generates a full SSL setup in the given base directory:
 *   <base>/ssl/server.key   (2048-bit RSA, mode 0600)
 *   <base>/ssl/server.crt   (self-signed, 365 days)
 *   <base>/ssl/server.pem   (key + cert combined)
 *   <base>/ssl/verification.txt
 */
async function generateSslSetup(base: string) {
  const sslDir = join(base, SSL_DIR)
  await mkdir(sslDir, { recursive: true })

  const keyPath = join(sslDir, KEY_FILE)
  const certPath = join(sslDir, CERT_FILE)
  const pemPath = join(sslDir, PEM_FILE)
  const verifyPath = join(sslDir, VERIFY_FILE)

  // Generate 2048-bit RSA private key
  await $`openssl genrsa -out ${keyPath} 2048`

  // Set 600 permissions on the key
  await $`chmod 600 ${keyPath}`

  // Generate self-signed certificate (365 days)
  await $`openssl req -new -x509 -key ${keyPath} -out ${certPath} -days ${VALIDITY_DAYS} -subj ${SUBJECT}`

  // Create combined PEM (key + cert)
  const keyContent = await readFile(keyPath, "utf-8")
  const certContent = await readFile(certPath, "utf-8")
  await writeFile(pemPath, keyContent + certContent)

  // Get certificate info for verification.txt
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

describe("SSL Certificate Setup", () => {
  let rootTmpDir: string
  let paths: Awaited<ReturnType<typeof generateSslSetup>>

  beforeAll(async () => {
    const tmp = await tmpdir()
    rootTmpDir = tmp.path
    paths = await generateSslSetup(rootTmpDir)
  })

  describe("Directory creation", () => {
    test("creates the ssl directory", async () => {
      const dirStat = await stat(paths.sslDir)
      expect(dirStat.isDirectory()).toBe(true)
    })
  })

  describe("Private key (server.key)", () => {
    test("generates a PEM-encoded RSA private key", async () => {
      const key = await readFile(paths.keyPath, "utf-8")
      // Accept both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
      expect(key).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
      expect(key).toMatch(/END (RSA )?PRIVATE KEY/)
    })

    test("key is 2048-bit RSA", async () => {
      const bitsOut = await $`openssl rsa -in ${paths.keyPath} -text -noout 2>/dev/null | head -1`.text()
      expect(bitsOut).toContain("2048 bit")
    })

    test("key file has 600 permissions (owner read/write only)", async () => {
      const keyStat = await stat(paths.keyPath)
      const permissions = keyStat.mode & 0o777
      expect(permissions).toBe(0o600)
    })
  })

  describe("Self-signed certificate (server.crt)", () => {
    test("creates a valid X.509 certificate", async () => {
      const cert = await readFile(paths.certPath, "utf-8")
      expect(cert).toContain("BEGIN CERTIFICATE")
      expect(cert).toContain("END CERTIFICATE")
    })

    test("certificate is self-signed (issuer equals subject)", async () => {
      const issuerOut = await $`openssl x509 -in ${paths.certPath} -noout -issuer`.text()
      const subjectOut = await $`openssl x509 -in ${paths.certPath} -noout -subject`.text()
      // Self-signed: issuer and subject are the same (strip different prefixes)
      const issuer = issuerOut.replace("issuer=", "").trim()
      const subject = subjectOut.replace("subject=", "").trim()
      expect(issuer).toBe(subject)
    })

    test("subject contains O=DevOps Team and CN=dev-internal.company.local", async () => {
      const subjectOut = await $`openssl x509 -in ${paths.certPath} -noout -subject`.text()
      // OpenSSL compact format: "O=DevOps Team, CN=dev-internal.company.local"
      expect(subjectOut).toContain("O=DevOps Team")
      expect(subjectOut).toContain("CN=dev-internal.company.local")
    })

    test("certificate is valid for approximately 365 days", async () => {
      const notBeforeOut = await $`openssl x509 -in ${paths.certPath} -noout -startdate`.text()
      const notAfterOut = await $`openssl x509 -in ${paths.certPath} -noout -enddate`.text()

      const startDate = new Date(notBeforeOut.replace("notBefore=", ""))
      const endDate = new Date(notAfterOut.replace("notAfter=", ""))

      const diffMs = endDate.getTime() - startDate.getTime()
      const diffDays = diffMs / (1000 * 60 * 60 * 24)

      // Allow some tolerance for timing
      expect(diffDays).toBeGreaterThanOrEqual(364)
      expect(diffDays).toBeLessThanOrEqual(366)
    })

    test("certificate has not expired yet", async () => {
      // Self-signed certs fail `openssl verify` without -CAfile,
      // so we parse the dates directly and verify they bracket now
      const textOut = await $`openssl x509 -in ${paths.certPath} -noout -dates`.text()
      expect(textOut).toContain("notBefore=")
      expect(textOut).toContain("notAfter=")

      const startStr = textOut.match(/notBefore=(.+)/)?.[1]
      const endStr = textOut.match(/notAfter=(.+)/)?.[1]
      expect(startStr).toBeDefined()
      expect(endStr).toBeDefined()

      const now = Date.now()
      const startDate = new Date(startStr!).getTime()
      const endDate = new Date(endStr!).getTime()
      expect(now).toBeGreaterThanOrEqual(startDate)
      expect(now).toBeLessThanOrEqual(endDate)
    })

    test("certificate uses SHA-256 signature algorithm", async () => {
      const sigAlg = await $`openssl x509 -in ${paths.certPath} -noout -text 2>/dev/null | grep "Signature Algorithm:" | head -1`.text()
      expect(sigAlg).toContain("sha256")
    })

    test("certificate public key is 2048-bit RSA", async () => {
      const keyBits = await $`openssl x509 -in ${paths.certPath} -noout -text 2>/dev/null | grep "Public-Key:"`.text()
      expect(keyBits).toContain("2048 bit")
    })
  })

  describe("Combined PEM (server.pem)", () => {
    test("server.pem exists", async () => {
      const pemStat = await stat(paths.pemPath)
      expect(pemStat.isFile()).toBe(true)
    })

    test("server.pem contains the private key", async () => {
      const pem = await readFile(paths.pemPath, "utf-8")
      // Accept both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
      expect(pem).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
      expect(pem).toMatch(/END (RSA )?PRIVATE KEY/)
    })

    test("server.pem contains the certificate", async () => {
      const pem = await readFile(paths.pemPath, "utf-8")
      expect(pem).toContain("BEGIN CERTIFICATE")
      expect(pem).toContain("END CERTIFICATE")
    })

    test("private key comes before certificate in combined PEM", async () => {
      const pem = await readFile(paths.pemPath, "utf-8")
      // Accept both PKCS#8 and PKCS#1 key headers for finding the key position
      const pkcs8Idx = pem.indexOf("BEGIN PRIVATE KEY")
      const pkcs1Idx = pem.indexOf("BEGIN RSA PRIVATE KEY")
      const keyIdx = pkcs1Idx >= 0 ? pkcs1Idx : pkcs8Idx
      const certIdx = pem.indexOf("BEGIN CERTIFICATE")
      expect(keyIdx).toBeGreaterThanOrEqual(0)
      expect(keyIdx).toBeLessThan(certIdx)
    })

    test("combined PEM is valid for TLS (key matches cert)", async () => {
      // Extract key modulus and cert modulus — they should match
      const keyModulus = await $`openssl rsa -in ${paths.pemPath} -modulus -noout 2>/dev/null`.text()
      const certModulus = await $`openssl x509 -in ${paths.pemPath} -modulus -noout 2>/dev/null`.text()
      expect(keyModulus.trim()).toBe(certModulus.trim())
    })

    test("combined PEM can be parsed as a valid key-certificate pair by openssl", async () => {
      // Write combined PEM to a temp file and verify it loads
      const checkResult = await $`openssl x509 -in ${paths.pemPath} -noout -subject 2>&1`.text()
      expect(checkResult).toContain("subject=")
    })
  })

  describe("Verification file (verification.txt)", () => {
    let verifyContent: string

    beforeAll(async () => {
      verifyContent = await readFile(paths.verifyPath, "utf-8")
    })

    test("verification.txt exists", async () => {
      const vStat = await stat(paths.verifyPath)
      expect(vStat.isFile()).toBe(true)
    })

    test("contains the certificate subject", () => {
      expect(verifyContent).toContain("subject=")
      // OpenSSL compact format: "O=DevOps Team, CN=dev-internal.company.local"
      expect(verifyContent).toContain("O=DevOps Team")
      expect(verifyContent).toContain("CN=dev-internal.company.local")
    })

    test("contains the validity start date", () => {
      expect(verifyContent).toContain("notBefore=")
    })

    test("contains the validity end date", () => {
      expect(verifyContent).toContain("notAfter=")
    })

    test("contains a SHA-256 fingerprint", () => {
      expect(verifyContent).toContain("sha256 Fingerprint")
      // SHA-256 fingerprint is 64 hex characters separated by colons
      const fingerprintMatch = verifyContent.match(/([0-9A-F]{2}:){31}[0-9A-F]{2}/i)
      expect(fingerprintMatch).not.toBeNull()
    })

    test("SHA-256 fingerprint matches the actual certificate", async () => {
      const actualFingerprint = await $`openssl x509 -in ${paths.certPath} -noout -fingerprint -sha256`.text()
      expect(verifyContent.trim()).toContain(actualFingerprint.trim())
    })

    test("verification.txt has exactly 4 lines (subject, start, end, fingerprint)", () => {
      const lines = verifyContent.split("\n").filter((l) => l.length > 0)
      expect(lines.length).toBe(4)
    })
  })

  describe("Full roundtrip integrity", () => {
    test("key, cert, and combined PEM all belong to the same key pair", async () => {
      const keyModulus = await $`openssl rsa -in ${paths.keyPath} -modulus -noout 2>/dev/null`.text()
      const certModulus = await $`openssl x509 -in ${paths.certPath} -modulus -noout 2>/dev/null`.text()
      const pemModulus = await $`openssl rsa -in ${paths.pemPath} -modulus -noout 2>/dev/null`.text()

      expect(keyModulus.trim()).toBe(certModulus.trim())
      expect(certModulus.trim()).toBe(pemModulus.trim())
    })

    test("key can decrypt/verify signatures made with the certificate's public key", async () => {
      const signTmp = join(rootTmpDir, "sign.bin")
      const pubTmp = join(rootTmpDir, "pub.pem")
      const dataTmp = join(rootTmpDir, "data.txt")

      await writeFile(dataTmp, "test-payload")

      // Sign with private key
      await $`openssl dgst -sha256 -sign ${paths.keyPath} -out ${signTmp} ${dataTmp}`

      // Extract public key from cert
      await $`openssl x509 -in ${paths.certPath} -pubkey -noout -out ${pubTmp}`

      // Verify signature
      const verifyResult = await $`openssl dgst -sha256 -verify ${pubTmp} -signature ${signTmp} ${dataTmp} 2>&1`.text()
      expect(verifyResult).toContain("Verified OK")
    })
  })
})
