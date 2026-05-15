import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { writeFile, readFile, stat, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "../fixture/fixture"

describe("SSL Private Key Generation", () => {
  let tempDir: string
  let keyPath: string
  let rootTmpDir: string

  beforeAll(async () => {
    const tmp = await tmpdir()
    rootTmpDir = tmp.path
    tempDir = join(rootTmpDir, "ssl")
    await mkdir(tempDir, { recursive: true })
    keyPath = join(tempDir, "server.key")
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  test("generates 2048-bit RSA private key", () => {
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

    expect(privateKey).toContain("BEGIN PRIVATE KEY")
    expect(privateKey).toContain("END PRIVATE KEY")
  })

  test("saves private key to specified path", async () => {
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

    const savedKey = await readFile(keyPath, "utf-8")
    expect(savedKey).toBe(privateKey)
  })

  test("file has 600 permissions (owner read/write only)", async () => {
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

    const fileStat = await stat(keyPath)
    const permissions = fileStat.mode & 0o777

    expect(permissions).toBe(0o600)
  })

  test("creates parent directories if they don't exist", async () => {
    const nestedDir = join(rootTmpDir, "ssl", "nested", "dirs")
    const nestedKeyPath = join(nestedDir, "server.key")

    await mkdir(nestedDir, { recursive: true })

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

    await writeFile(nestedKeyPath, privateKey, { mode: 0o600 })

    const fileStat = await stat(nestedKeyPath)
    expect(fileStat.isFile()).toBe(true)

    const permissions = fileStat.mode & 0o777
    expect(permissions).toBe(0o600)
  })
})

describe("Complete SSL Setup", () => {
  test("generates key and sets permissions in one operation", async () => {
    const tmp = await tmpdir()
    const tempDir = join(tmp.path, "ssl-complete")
    await mkdir(tempDir, { recursive: true })
    const keyPath = join(tempDir, "server.key")

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

    const fileStat = await stat(keyPath)
    const savedKey = await readFile(keyPath, "utf-8")

    expect(savedKey).toBe(privateKey)
    expect(fileStat.mode & 0o777).toBe(0o600)
    expect(savedKey).toContain("BEGIN PRIVATE KEY")
  })
})
