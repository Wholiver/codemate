import { describe, test, expect } from "bun:test"
import { $ } from "bun"
import { readFile, stat, access } from "node:fs/promises"
import { join } from "node:path"

/**
 * Validates the actual SSL infrastructure in ssl/ at the project root.
 *
 * Checks:
 *   1. Key file permissions are 600
 *   2. Certificate matches private key via modulus comparison
 *   3. Combined PEM contains both key and certificate
 *   4. verification.txt contains subject, dates, and SHA-256 fingerprint
 */

const SSL_DIR = join(import.meta.dir, "..", "..", "ssl")
const KEY_PATH = join(SSL_DIR, "keys", "server.key")
const CERT_PATH = join(SSL_DIR, "certs", "server.crt")
const PEM_PATH = join(SSL_DIR, "certs", "server.pem")
const VERIFY_PATH = join(SSL_DIR, "verification.txt")

describe("SSL Infrastructure Validation", () => {
  describe("1. Key file permissions", () => {
    test("server.key exists", async () => {
      await access(KEY_PATH)
      const s = await stat(KEY_PATH)
      expect(s.isFile()).toBe(true)
    })

    test("server.key has 600 permissions (owner read/write only)", async () => {
      const keyStat = await stat(KEY_PATH)
      const permissions = keyStat.mode & 0o777
      expect(permissions).toBe(0o600)
    })

    test("server.key is a valid RSA private key", async () => {
      const content = await readFile(KEY_PATH, "utf-8")
      // Accept both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
      expect(content).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
      expect(content).toMatch(/END (RSA )?PRIVATE KEY/)
    })
  })

  describe("2. Certificate matches private key (modulus comparison)", () => {
    test("server.crt exists and is valid", async () => {
      await access(CERT_PATH)
      const s = await stat(CERT_PATH)
      expect(s.isFile()).toBe(true)
    })

    test("key modulus matches certificate modulus", async () => {
      const keyModulus = (
        await $`openssl rsa -in ${KEY_PATH} -modulus -noout 2>/dev/null`
      ).stdout
        .toString()
        .trim()
      const certModulus = (
        await $`openssl x509 -in ${CERT_PATH} -modulus -noout 2>/dev/null`
      ).stdout
        .toString()
        .trim()
      expect(keyModulus).toBe(certModulus)
      expect(keyModulus.length).toBeGreaterThan(0)
    })

    test("certificate is self-signed (issuer equals subject)", async () => {
      const issuerOut = (
        await $`openssl x509 -in ${CERT_PATH} -noout -issuer`
      ).stdout
        .toString()
        .trim()
      const subjectOut = (
        await $`openssl x509 -in ${CERT_PATH} -noout -subject`
      ).stdout
        .toString()
        .trim()
      const issuer = issuerOut.replace("issuer=", "").trim()
      const subject = subjectOut.replace("subject=", "").trim()
      expect(issuer).toBe(subject)
    })

    test("certificate has not expired", async () => {
      const result = await $`openssl x509 -in ${CERT_PATH} -noout -checkend 0`.quiet()
      expect(result.exitCode).toBe(0)
    })

    test("certificate uses SHA-256 signature algorithm", async () => {
      const output = (
        await $`openssl x509 -in ${CERT_PATH} -noout -text 2>/dev/null`
      ).stdout
        .toString()
      expect(output).toContain("sha256")
    })
  })

  describe("3. Combined PEM (server.pem) validates as key+cert", () => {
    test("server.pem exists", async () => {
      await access(PEM_PATH)
      const s = await stat(PEM_PATH)
      expect(s.isFile()).toBe(true)
    })

    test("PEM contains the private key block", async () => {
      const pem = await readFile(PEM_PATH, "utf-8")
      // Accept both PKCS#8 (BEGIN PRIVATE KEY) and PKCS#1 (BEGIN RSA PRIVATE KEY)
      expect(pem).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
      expect(pem).toMatch(/END (RSA )?PRIVATE KEY/)
    })

    test("PEM contains the certificate block", async () => {
      const pem = await readFile(PEM_PATH, "utf-8")
      expect(pem).toContain("BEGIN CERTIFICATE")
      expect(pem).toContain("END CERTIFICATE")
    })

    test("key modulus from PEM matches certificate modulus from PEM", async () => {
      const keyModulus = (
        await $`openssl rsa -in ${PEM_PATH} -modulus -noout 2>/dev/null`
      ).stdout
        .toString()
        .trim()
      const certModulus = (
        await $`openssl x509 -in ${PEM_PATH} -modulus -noout 2>/dev/null`
      ).stdout
        .toString()
        .trim()
      expect(keyModulus).toBe(certModulus)
    })

    test("PEM modulus matches separate key and cert modulus", async () => {
      const separateKeyModulus = (
        await $`openssl rsa -in ${KEY_PATH} -modulus -noout 2>/dev/null`
      ).stdout
        .toString()
        .trim()
      const pemKeyModulus = (
        await $`openssl rsa -in ${PEM_PATH} -modulus -noout 2>/dev/null`
      ).stdout
        .toString()
        .trim()
      expect(pemKeyModulus).toBe(separateKeyModulus)
    })
  })

  describe("4. verification.txt contains subject, dates, and SHA-256 fingerprint", () => {
    let content: string

    test("verification.txt exists and is readable", async () => {
      await access(VERIFY_PATH)
      const s = await stat(VERIFY_PATH)
      expect(s.isFile()).toBe(true)
      content = await readFile(VERIFY_PATH, "utf-8")
    })

    test("contains the certificate subject (O=DevOps Team, CN=dev-internal.company.local)", async () => {
      if (!content) content = await readFile(VERIFY_PATH, "utf-8")
      expect(content).toContain("O=DevOps Team")
      expect(content).toContain("CN=dev-internal.company.local")
    })

    test("contains a validity start date (notBefore or Not Before)", async () => {
      if (!content) content = await readFile(VERIFY_PATH, "utf-8")
      // Matches both formats: "notBefore=..." and "Not Before: ..."
      const hasStartDate =
        content.includes("notBefore=") || content.includes("Not Before:")
      expect(hasStartDate).toBe(true)
    })

    test("contains a validity end date (notAfter or Not After)", async () => {
      if (!content) content = await readFile(VERIFY_PATH, "utf-8")
      // Matches both formats: "notAfter=..." and "Not After: ..."
      const hasEndDate =
        content.includes("notAfter=") || content.includes("Not After:")
      expect(hasEndDate).toBe(true)
    })

    test("contains a SHA-256 fingerprint", async () => {
      if (!content) content = await readFile(VERIFY_PATH, "utf-8")
      // SHA-256 fingerprint is 64 hex characters separated by colons
      const fingerprintMatch = content.match(
        /([0-9A-F]{2}:){31}[0-9A-F]{2}/i,
      )
      expect(fingerprintMatch).not.toBeNull()
    })

    test("SHA-256 fingerprint in verification.txt matches actual certificate", async () => {
      if (!content) content = await readFile(VERIFY_PATH, "utf-8")
      const actualFingerprint = (
        await $`openssl x509 -in ${CERT_PATH} -noout -fingerprint -sha256`
      ).stdout
        .toString()
        .trim()
      // Extract just the hex value (after the '=' sign) since labels may differ
      const actualHex = actualFingerprint.split("=")[1]?.trim()
      expect(actualHex).toBeDefined()
      // The verification.txt may use a different label (e.g. "SHA256 Finger:")
      // so match against the pure hex fingerprint value
      expect(content).toContain(actualHex!)
    })

    test("dates in verification.txt match the actual certificate dates", async () => {
      if (!content) content = await readFile(VERIFY_PATH, "utf-8")
      const notBeforeOut = (
        await $`openssl x509 -in ${CERT_PATH} -noout -startdate`
      ).stdout
        .toString()
        .trim()
      const notAfterOut = (
        await $`openssl x509 -in ${CERT_PATH} -noout -enddate`
      ).stdout
        .toString()
        .trim()

      // Verify the actual date strings appear in verification.txt
      expect(content).toContain(notBeforeOut.replace("notBefore=", "").trim())
      expect(content).toContain(notAfterOut.replace("notAfter=", "").trim())
    })
  })
})
