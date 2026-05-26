import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { $ } from "bun"
import { writeFile, readFile, stat, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "../fixture/fixture"

/**
 * Tests for /app/check_cert.py Python script.
 *
 * The script loads a PEM or DER certificate, verifies it is within its validity
 * window, prints the Common Name (CN) and the expiration date formatted as
 * YYYY-MM-DD, and prints 'Certificate verification successful' when all checks pass.
 */

// ─── helpers ────────────────────────────────────────────────────────────

const CHECK_CERT_PY = join(import.meta.dir, "check_cert.py")

/** Run check_cert.py and always return the result (never throws on non-zero exit). */
async function runCheckCert(certPath: string): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  try {
    const result = await $`python3 ${CHECK_CERT_PY} ${certPath}`.quiet()
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } catch (err: any) {
    return { exitCode: err.exitCode ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" }
  }
}

/** Run an arbitrary command, always returning the result. */
async function sh(parts: TemplateStringsArray, ...args: any[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  try {
    const result = await $(parts, ...args).quiet()
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  } catch (err: any) {
    return { exitCode: err.exitCode ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" }
  }
}

async function generateCert(opts: {
  subject?: string
  days?: number
  format?: "pem" | "der"
  outDir: string
}) {
  const {
    subject = "/C=US/ST=State/L=City/O=Org/CN=localhost",
    days = 365,
    format = "pem",
    outDir,
  } = opts

  await mkdir(outDir, { recursive: true })

  const keyPath = join(outDir, "server.key")
  const tmpCertPath = join(outDir, "server.pem.tmp")
  const certPath = join(outDir, format === "der" ? "server.der" : "server.crt")

  // Generate 2048-bit RSA key + self-signed cert in PEM
  await sh`openssl req -new -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${tmpCertPath} -x509 -days ${days} -subj ${subject}`

  // Remove key (not needed for tests)
  await rm(keyPath).catch(() => {})

  // Convert to DER if requested, otherwise rename PEM to .crt
  if (format === "der") {
    await sh`openssl x509 -in ${tmpCertPath} -outform DER -out ${certPath}`
    await rm(tmpCertPath)
  } else {
    // Rename .pem.tmp to .crt (openSSL already wrote PEM content)
    const { rename } = await import("node:fs/promises")
    await rename(tmpCertPath, certPath)
  }

  return certPath
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("check_cert.py", () => {
  // ── Basic functionality ──────────────────────────────────────────────

  describe("loads and verifies a valid certificate", () => {
    let certPath: string
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
      certPath = await generateCert({
        subject: "/C=US/ST=California/L=SanFrancisco/O=Acme Corp/CN=api.acme.com",
        days: 365,
        outDir: join(tmp.path, "valid-cert"),
      })
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("exits with code 0 for a valid certificate", async () => {
      const result = await runCheckCert(certPath)
      expect(result.exitCode).toBe(0)
    })

    test("prints Common Name from the certificate subject", async () => {
      const result = await runCheckCert(certPath)
      expect(result.stdout).toContain("Common Name: api.acme.com")
    })

    test("prints expiration date in YYYY-MM-DD format", async () => {
      const result = await runCheckCert(certPath)
      const dateMatch = result.stdout.match(/Expiration Date: (\d{4}-\d{2}-\d{2})/)
      expect(dateMatch).not.toBeNull()
      // Verify the date is a valid calendar date
      const dateStr = dateMatch![1]
      const [year, month, day] = dateStr.split("-").map(Number)
      expect(year).toBeGreaterThanOrEqual(2025)
      expect(month).toBeGreaterThanOrEqual(1)
      expect(month).toBeLessThanOrEqual(12)
      expect(day).toBeGreaterThanOrEqual(1)
      expect(day).toBeLessThanOrEqual(31)
    })

    test("prints 'Certificate verification successful' on success", async () => {
      const result = await runCheckCert(certPath)
      expect(result.stdout).toContain("Certificate verification successful")
    })

    test("output contains all three expected lines", async () => {
      const result = await runCheckCert(certPath)
      const lines = result.stdout
        .split("\n")
        .filter((l) => l.trim().length > 0)
      expect(lines.length).toBe(3)
      expect(lines[0]).toMatch(/^Common Name: /)
      expect(lines[1]).toMatch(/^Expiration Date: /)
      expect(lines[2]).toBe("Certificate verification successful")
    })
  })

  // ── Common Name extraction ───────────────────────────────────────────

  describe("Common Name extraction", () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("extracts CN from a complex subject", async () => {
      const certPath = await generateCert({
        subject: "/C=DE/ST=Berlin/O=Tech GmbH/OU=Engineering/CN=secure.tech-gmbh.de",
        outDir: join(tmp.path, "complex-cn"),
      })
      const result = await runCheckCert(certPath)
      expect(result.stdout).toContain("Common Name: secure.tech-gmbh.de")
    })

    test("extracts CN with dots and hyphens", async () => {
      const certPath = await generateCert({
        subject: "/CN=my-service.internal.example.com",
        outDir: join(tmp.path, "dotted-cn"),
      })
      const result = await runCheckCert(certPath)
      expect(result.stdout).toContain("Common Name: my-service.internal.example.com")
    })

    test("extracts CN with an IP address as CN", async () => {
      const certPath = await generateCert({
        subject: "/CN=192.168.1.100",
        outDir: join(tmp.path, "ip-cn"),
      })
      const result = await runCheckCert(certPath)
      expect(result.stdout).toContain("Common Name: 192.168.1.100")
    })
  })

  // ── Expiration date format ───────────────────────────────────────────

  describe("Expiration Date formatting", () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("date is in YYYY-MM-DD format (no time component)", async () => {
      const certPath = await generateCert({ days: 365, outDir: join(tmp.path, "date-format") })
      const result = await runCheckCert(certPath)
      // Should match exactly YYYY-MM-DD followed by newline (no T or time)
      expect(result.stdout).toMatch(/Expiration Date: \d{4}-\d{2}-\d{2}\n/)
    })

    test("expiration date is approximately 365 days from now for a 365-day cert", async () => {
      const certPath = await generateCert({ days: 365, outDir: join(tmp.path, "date-365") })
      const result = await runCheckCert(certPath)
      const dateMatch = result.stdout.match(/Expiration Date: (\d{4}-\d{2}-\d{2})/)
      expect(dateMatch).not.toBeNull()

      const expDate = new Date(dateMatch![1])
      const now = new Date()
      const diffMs = expDate.getTime() - now.getTime()
      const diffDays = diffMs / (1000 * 60 * 60 * 24)

      // Allow tolerance of ±1 day for execution timing
      expect(diffDays).toBeGreaterThanOrEqual(364)
      expect(diffDays).toBeLessThanOrEqual(366)
    })

    test("expiration date is approximately 30 days from now for a 30-day cert", async () => {
      const certPath = await generateCert({ days: 30, outDir: join(tmp.path, "date-30") })
      const result = await runCheckCert(certPath)
      const dateMatch = result.stdout.match(/Expiration Date: (\d{4}-\d{2}-\d{2})/)
      expect(dateMatch).not.toBeNull()

      const expDate = new Date(dateMatch![1])
      const now = new Date()
      const diffMs = expDate.getTime() - now.getTime()
      const diffDays = diffMs / (1000 * 60 * 60 * 24)

      expect(diffDays).toBeGreaterThanOrEqual(29)
      expect(diffDays).toBeLessThanOrEqual(31)
    })
  })

  // ── Certificate verification ─────────────────────────────────────────

  describe("certificate verification", () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("successful verification for a valid, non-expired certificate", async () => {
      const certPath = await generateCert({ days: 365, outDir: join(tmp.path, "verify-valid") })
      const result = await runCheckCert(certPath)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Certificate verification successful")
    })

    test("fails for an already-expired certificate", async () => {
      const certPath = join(tmp.path, "expired-cert.pem")

      // Create a certificate that expired 10 days ago (validity window: 30 days ago → 10 days ago)
      const maker = join(tmp.path, "make_expired.py")
      await writeFile(
        maker,
        `
import sys
from datetime import datetime, timezone, timedelta
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "expired.test")])
now = datetime.now(timezone.utc)
cert = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(issuer)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - timedelta(days=30))
    .not_valid_after(now - timedelta(days=10))
    .sign(key, hashes.SHA256())
)
with open(sys.argv[1], "wb") as f:
    f.write(cert.public_bytes(serialization.Encoding.PEM))
`,
        { encoding: "utf-8" },
      )
      await sh`python3 ${maker} ${certPath}`

      const result = await runCheckCert(certPath)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain("Common Name: expired.test")
      expect(result.stdout).toContain("Expiration Date:")
      expect(result.stdout).toContain("Certificate verification failed")
    })
  })

  // ── Error handling ───────────────────────────────────────────────────

  describe("error handling", () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("exits with code 1 when no arguments are provided", async () => {
      const result = await sh`python3 ${CHECK_CERT_PY}`
      expect(result.exitCode).toBe(1)
    })

    test("prints usage message when no arguments are provided", async () => {
      const result = await sh`python3 ${CHECK_CERT_PY}`
      expect(result.stderr).toContain("Usage:")
    })

    test("exits with error for a non-existent file", async () => {
      const result = await runCheckCert("/tmp/nonexistent-cert.pem")
      expect(result.exitCode).not.toBe(0)
    })

    test("exits with error for an invalid/corrupted certificate file", async () => {
      const badCertPath = join(tmp.path, "bad-cert.pem")
      await writeFile(badCertPath, "this is not a certificate", "utf-8")
      const result = await runCheckCert(badCertPath)
      expect(result.exitCode).not.toBe(0)
    })
  })

  // ── DER format support ───────────────────────────────────────────────

  describe("DER format certificate support", () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("loads and verifies a DER-encoded certificate", async () => {
      const certPath = await generateCert({
        subject: "/CN=der-test.local",
        days: 365,
        format: "der",
        outDir: join(tmp.path, "der-cert"),
      })
      const result = await runCheckCert(certPath)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Common Name: der-test.local")
      expect(result.stdout).toContain("Certificate verification successful")
    })
  })

  // ── Self-signed certificate acceptance ───────────────────────────────

  describe("self-signed certificates", () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("accepts a self-signed certificate (no CA chain needed)", async () => {
      const certPath = await generateCert({
        subject: "/CN=self-signed.test",
        days: 365,
        outDir: join(tmp.path, "self-signed"),
      })
      const result = await runCheckCert(certPath)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Certificate verification successful")
    })
  })

  // ── Multiple certificates in sequence ────────────────────────────────

  describe("multiple certificates", () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("can verify multiple distinct PEM certificates sequentially", async () => {
      const cert1 = await generateCert({
        subject: "/CN=multi-one.test",
        days: 365,
        outDir: join(tmp.path, "multi-1"),
      })
      const cert2 = await generateCert({
        subject: "/CN=multi-two.test",
        days: 90,
        outDir: join(tmp.path, "multi-2"),
      })

      const r1 = await runCheckCert(cert1)
      const r2 = await runCheckCert(cert2)

      expect(r1.exitCode).toBe(0)
      expect(r1.stdout).toContain("Common Name: multi-one.test")
      expect(r1.stdout).toContain("Certificate verification successful")

      expect(r2.exitCode).toBe(0)
      expect(r2.stdout).toContain("Common Name: multi-two.test")
      expect(r2.stdout).toContain("Certificate verification successful")
    })

    test("can verify PEM and DER certificates of the same CN", async () => {
      const subject = "/CN=dual-format.test"
      const pemPath = await generateCert({ subject, days: 365, format: "pem", outDir: join(tmp.path, "dual-pem") })
      const derPath = await generateCert({ subject, days: 365, format: "der", outDir: join(tmp.path, "dual-der") })

      const rPem = await runCheckCert(pemPath)
      const rDer = await runCheckCert(derPath)

      expect(rPem.exitCode).toBe(0)
      expect(rPem.stdout).toContain("Common Name: dual-format.test")
      expect(rPem.stdout).toContain("Certificate verification successful")

      expect(rDer.exitCode).toBe(0)
      expect(rDer.stdout).toContain("Common Name: dual-format.test")
      expect(rDer.stdout).toContain("Certificate verification successful")
    })
  })

  // ── DER format additional checks ────────────────────────────────────

  describe("DER format additional coverage", () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("DER certificate shows correct expiration date in YYYY-MM-DD", async () => {
      const certPath = await generateCert({
        subject: "/CN=der-date.test",
        days: 365,
        format: "der",
        outDir: join(tmp.path, "der-date"),
      })
      const result = await runCheckCert(certPath)
      expect(result.exitCode).toBe(0)
      const dateMatch = result.stdout.match(/Expiration Date: (\d{4}-\d{2}-\d{2})/)
      expect(dateMatch).not.toBeNull()
    })

    test("DER certificate with long subject fields works", async () => {
      const certPath = await generateCert({
        subject: "/C=US/ST=California/L=SanFrancisco/O=Very Long Organization Name Inc/OU=Platform Engineering/CN=platform-eng.very-long-organization-name.internal.example.com",
        days: 365,
        format: "der",
        outDir: join(tmp.path, "der-long"),
      })
      const result = await runCheckCert(certPath)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Common Name: platform-eng.very-long-organization-name.internal.example.com")
      expect(result.stdout).toContain("Certificate verification successful")
    })
  })

  // ── Certificate expiry boundary ──────────────────────────────────────

  describe("expiry boundary", () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("cert valid for only 1 day is still accepted", async () => {
      const certPath = await generateCert({
        subject: "/CN=short-lived.test",
        days: 1,
        outDir: join(tmp.path, "short-lived"),
      })
      const result = await runCheckCert(certPath)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Certificate verification successful")
    })

    test("cert with very long validity (10 years) is accepted", async () => {
      const certPath = await generateCert({
        subject: "/CN=long-lived.test",
        days: 3650,
        outDir: join(tmp.path, "long-lived"),
      })
      const result = await runCheckCert(certPath)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Common Name: long-lived.test")
      expect(result.stdout).toContain("Certificate verification successful")
    })
  })

  // ── Output format validation ────────────────────────────────────────

  describe("output format validation", () => {
    let tmp: Awaited<ReturnType<typeof tmpdir>>

    beforeAll(async () => {
      tmp = await tmpdir()
    })

    afterAll(async () => {
      await rm(tmp.path, { recursive: true, force: true }).catch(() => {})
    })

    test("Common Name line has no trailing whitespace", async () => {
      const certPath = await generateCert({
        subject: "/CN=whitespace.test",
        days: 365,
        outDir: join(tmp.path, "whitespace"),
      })
      const result = await runCheckCert(certPath)
      const lines = result.stdout.split("\n")
      const cnLine = lines.find((l) => l.startsWith("Common Name:"))
      expect(cnLine).toBeDefined()
      expect(cnLine).toBe(cnLine!.trimEnd())
    })

    test("Expiration Date line has no trailing whitespace", async () => {
      const certPath = await generateCert({
        subject: "/CN=date-ws.test",
        days: 365,
        outDir: join(tmp.path, "date-ws"),
      })
      const result = await runCheckCert(certPath)
      const lines = result.stdout.split("\n")
      const dateLine = lines.find((l) => l.startsWith("Expiration Date:"))
      expect(dateLine).toBeDefined()
      expect(dateLine).toBe(dateLine!.trimEnd())
    })

    test("stderr is empty on successful verification", async () => {
      const certPath = await generateCert({
        subject: "/CN=stderr.test",
        days: 365,
        outDir: join(tmp.path, "stderr"),
      })
      const result = await runCheckCert(certPath)
      expect(result.exitCode).toBe(0)
      expect(result.stderr.trim()).toBe("")
    })
  })

  // ── Script metadata ─────────────────────────────────────────────────

  describe("script metadata", () => {
    test("check_cert.py exists and is readable", async () => {
      const fileStat = await stat(CHECK_CERT_PY)
      expect(fileStat.isFile()).toBe(true)
    })

    test("check_cert.py has a shebang line", async () => {
      const content = await readFile(CHECK_CERT_PY, "utf-8")
      const firstLine = content.split("\n")[0]
      expect(firstLine).toContain("#!/usr/bin/env python3")
    })
  })
})
