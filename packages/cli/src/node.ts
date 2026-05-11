import { spawn } from "node:child_process"

export async function run(input: { args?: string[] } = {}) {
  const args = input.args ?? []
  const executable = process.env.CODEMATE_BIN_PATH ?? "codemate"
  const command = [executable, ...args]

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`CLI terminated by signal ${signal}`))
        return
      }
      if ((code ?? 1) !== 0) {
        reject(new Error(`CLI exited with code ${code ?? 1}`))
        return
      }
      resolve()
    })
  })
}
