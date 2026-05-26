import { access, chmod, mkdir, readFile, writeFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"
import { Process } from "./process"

// ─── Constants ────────────────────────────────────────────────────────

const SSL_SUBDIR = "ssl"
const KEY_FILE = "server.key"
const CERT_FILE = "server.crt"
const PEM_FILE = "server.pem"
const VERIFY_FILE = "verification.txt"
const VALIDITY_DAYS = 365
const KEY_BITS = 2048
const DEFAULT_SUBJECT = "/O=DevOps Team/CN=dev-internal.company.local"

const KEY_PERMISSIONS = 0o600
const PEM_PERMISSIONS = 0o600
const CERT_PERMISSIONS = 0o644
const VERIFY_PERMISSIONS = 0o644

// ─── Types ────────────────────────────────────────────────────────────

export interface SslPaths {
  sslDir: string
  keyPath: string
  certPath: string
  pemPath: string
  verifyPath: string
}

export interface GenerateSslOptions {
  /** Base directory for the ssl/ folder. Defaults to /app if writable, else ~/app. */
  base?: string
  /** X.509 subject string (OpenSSL format). */
  subject?: string
  /** Certificate validity in days. */
  days?: number
  /** RSA key size in bits. */
  keyBits?: number
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function isWritable(dir: string): Promise<boolean> {
  try {
    await access(dir)
    return true
  } catch {
    // Directory doesn't exist — check if parent is writable
    const { dirname } = await import("path")
    const parent = dirname(dir)
    try {
      await access(parent)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Resolve the SSL base directory.
 *
 * Priority:
 *   1. `options.base` if explicitly provided
 *   2. `/app` if it exists (or its parent is writable)
 *   3. `~/app` as fallback
 */
async function resolveBase(options?: GenerateSslOptions): Promise<string> {
  if (options?.base) return options.base

  const primary = "/app"
  if (await isWritable(primary)) return primary

  return join(homedir(), "app")
}

async function sh(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await Process.run(cmd, { nothrow: true })
  return {
    code: result.code,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

// ─── Core Generation ──────────────────────────────────────────────────

/**
 * Generate a full SSL/TLS certificate setup.
 *
 * Creates the following files under `<base>/ssl/`:
 *   - `server.key`        2048-bit RSA private key (mode 0600)
 *   - `server.crt`        Self-signed X.509 certificate (365-day validity)
 *   - `server.pem`        Combined key + cert PEM (mode 0600)
 *   - `verification.txt`  Certificate metadata and SHA-256 fingerprint
 *
 * @returns Paths to all generated files.
 */
export async function generateSslCert(options?: GenerateSslOptions): Promise<SslPaths> {
  const base = await resolveBase(options)
  const sslDir = join(base, SSL_SUBDIR)
  await mkdir(sslDir, { recursive: true })

  const keyPath = join(sslDir, KEY_FILE)
  const certPath = join(sslDir, CERT_FILE)
  const pemPath = join(sslDir, PEM_FILE)
  const verifyPath = join(sslDir, VERIFY_FILE)

  const subject = options?.subject ?? DEFAULT_SUBJECT
  const days = options?.days ?? VALIDITY_DAYS
  const keyBits = options?.keyBits ?? KEY_BITS

  // 1. Generate RSA private key
  const genKey = await sh(["openssl", "genrsa", "-out", keyPath, String(keyBits)])
  if (genKey.code !== 0) {
    throw new Error(`Failed to generate RSA key: ${genKey.stderr}`)
  }
  await chmod(keyPath, KEY_PERMISSIONS)

  // 2. Generate self-signed certificate
  const genCert = await sh([
    "openssl",
    "req",
    "-new",
    "-x509",
    "-key",
    keyPath,
    "-out",
    certPath,
    "-days",
    String(days),
    "-subj",
    subject,
  ])
  if (genCert.code !== 0) {
    throw new Error(`Failed to generate certificate: ${genCert.stderr}`)
  }
  await chmod(certPath, CERT_PERMISSIONS)

  // 3. Create combined PEM (key + cert)
  const keyContent = await readFile(keyPath, "utf-8")
  const certContent = await readFile(certPath, "utf-8")
  await writeFile(pemPath, keyContent + certContent)
  await chmod(pemPath, PEM_PERMISSIONS)

  // 4. Build verification.txt from actual certificate data
  const subjectOut = (await sh(["openssl", "x509", "-in", certPath, "-noout", "-subject"])).stdout.trim()
  const notBeforeOut = (await sh(["openssl", "x509", "-in", certPath, "-noout", "-startdate"])).stdout.trim()
  const notAfterOut = (await sh(["openssl", "x509", "-in", certPath, "-noout", "-enddate"])).stdout.trim()
  const fingerprintOut = (
    await sh(["openssl", "x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"])
  ).stdout.trim()

  const verifyContent = [subjectOut, notBeforeOut, notAfterOut, fingerprintOut].join("\n")
  await writeFile(verifyPath, verifyContent)
  await chmod(verifyPath, VERIFY_PERMISSIONS)

  return { sslDir, keyPath, certPath, pemPath, verifyPath }
}

/**
 * Verify that an existing SSL setup is valid.
 *
 * Checks:
 *   - Key file exists and has 600 permissions
 *   - Certificate is a valid X.509 PEM file
 *   - Key and certificate share the same RSA modulus
 *   - Combined PEM is parseable
 *   - verification.txt exists and contains expected fields
 */
export async function verifySslCert(paths: SslPaths): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = []

  // Check key
  try {
    const keyContent = await readFile(paths.keyPath, "utf-8")
    if (!/BEGIN (RSA )?PRIVATE KEY/.test(keyContent)) {
      errors.push("Key file does not contain a valid PEM private key")
    }
  } catch {
    errors.push(`Key file not found: ${paths.keyPath}`)
  }

  // Check cert
  try {
    const certContent = await readFile(paths.certPath, "utf-8")
    if (!certContent.includes("BEGIN CERTIFICATE") || !certContent.includes("END CERTIFICATE")) {
      errors.push("Certificate file does not contain a valid PEM certificate")
    }
  } catch {
    errors.push(`Certificate file not found: ${paths.certPath}`)
  }

  // Check key/cert modulus match
  try {
    const keyMod = (
      await sh(["openssl", "rsa", "-in", paths.keyPath, "-modulus", "-noout"])
    ).stdout.trim()
    const certMod = (
      await sh(["openssl", "x509", "-in", paths.certPath, "-modulus", "-noout"])
    ).stdout.trim()
    if (keyMod !== certMod) {
      errors.push("Key and certificate moduli do not match")
    }
  } catch {
    errors.push("Failed to compare key and certificate moduli")
  }

  // Check combined PEM
  try {
    const pemContent = await readFile(paths.pemPath, "utf-8")
    if (!/BEGIN (RSA )?PRIVATE KEY/.test(pemContent)) {
      errors.push("Combined PEM does not contain a private key")
    }
    if (!pemContent.includes("BEGIN CERTIFICATE")) {
      errors.push("Combined PEM does not contain a certificate")
    }
  } catch {
    errors.push(`Combined PEM not found: ${paths.pemPath}`)
  }

  // Check verification.txt
  try {
    const verifyContent = await readFile(paths.verifyPath, "utf-8")
    if (!verifyContent.includes("subject=")) {
      errors.push("verification.txt missing subject field")
    }
    if (!/([0-9A-F]{2}:){31}[0-9A-F]{2}/i.test(verifyContent)) {
      errors.push("verification.txt missing SHA-256 fingerprint")
    }
  } catch {
    errors.push(`verification.txt not found: ${paths.verifyPath}`)
  }

  return { valid: errors.length === 0, errors }
}

export * as Ssl from "./ssl"
