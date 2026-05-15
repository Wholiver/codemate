import { afterEach, test, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { disposeAllInstances, provideInstance, tmpdir } from "../fixture/fixture"
import { WithInstance } from "../../src/project/with-instance"
import { Agent } from "../../src/agent/agent"
import { Global } from "@codemate-ai/core/global"
import { Flag } from "@codemate-ai/core/flag/flag"
import { Permission } from "../../src/permission"

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): Permission.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

async function withExperimentalScout(enabled: boolean, fn: () => Promise<void>) {
  const original = Flag.codemate_EXPERIMENTAL_SCOUT
  Flag.codemate_EXPERIMENTAL_SCOUT = enabled
  try {
    await fn()
  } finally {
    Flag.codemate_EXPERIMENTAL_SCOUT = original
  }
}

afterEach(async () => {
  await disposeAllInstances()
})

test("returns default native agents when no config", async () => {
  await withExperimentalScout(false, async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const agents = await load(tmp.path, (svc) => svc.list())
        const names = agents.map((a) => a.name)
        expect(names).toContain("orchestrator")
        expect(names).toContain("planner")
        expect(names).toContain("coder")
        expect(names).toContain("tester")
        expect(names).toContain("research")
        expect(names).toContain("reviewer")
        expect(names).toContain("writer")
        expect(names).toContain("compaction")
        expect(names).toContain("title")
        expect(names).toContain("summary")
      },
    })
  })
})

test("orchestrator agent has correct default properties", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(plan).toBeDefined()
      expect(plan?.mode).toBe("primary")
      expect(plan?.native).toBe(true)
      expect(evalPerm(plan, "edit")).toBe("deny")
      expect(evalPerm(plan, "bash")).toBe("deny")
      expect(evalPerm(plan, "task")).toBe("allow")
      expect(evalPerm(plan, "todowrite")).toBe("deny")
      expect(evalPerm(plan, "question")).toBe("allow")
      expect(evalPerm(plan, "read")).toBe("allow")
      expect(evalPerm(plan, "repo_clone")).toBe("deny")
      expect(evalPerm(plan, "repo_overview")).toBe("deny")
    },
  })
})

test("orchestrator agent has read-only orchestration permissions", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(plan).toBeDefined()
      expect(plan?.mode).toBe("primary")
      expect(plan?.native).toBe(true)
      expect(evalPerm(plan, "task")).toBe("allow")
      expect(evalPerm(plan, "todowrite")).toBe("deny")
      expect(evalPerm(plan, "question")).toBe("allow")
      expect(evalPerm(plan, "read")).toBe("allow")
      expect(evalPerm(plan, "edit")).toBe("deny")
      expect(evalPerm(plan, "write")).toBe("deny")
      expect(evalPerm(plan, "patch")).toBe("deny")
      expect(evalPerm(plan, "bash")).toBe("deny")
      expect(evalPerm(plan, "repo_clone")).toBe("deny")
      expect(evalPerm(plan, "repo_overview")).toBe("deny")
    },
  })
})

test("planner agent denies edit and write", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const planner = await load(tmp.path, (svc) => svc.get("planner"))
      expect(planner).toBeDefined()
      expect(planner?.mode).toBe("subagent")
      expect(evalPerm(planner, "edit")).toBe("deny")
      expect(evalPerm(planner, "write")).toBe("deny")
      expect(evalPerm(planner, "todowrite")).toBe("deny")
    },
  })
})

test("planner agent asks for external directories and allows whitelisted external paths", async () => {
  const { Truncate } = await import("../../src/tool/truncate")
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const planner = await load(tmp.path, (svc) => svc.get("planner"))
      expect(planner).toBeDefined()
      expect(Permission.evaluate("external_directory", "/some/other/path", planner!.permission).action).toBe("ask")
      expect(Permission.evaluate("external_directory", Truncate.GLOB, planner!.permission).action).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(Global.Path.tmp, "agent-work"), planner!.permission).action,
      ).toBe("allow")
    },
  })
})

test("research agent allows repo cloning and repo cache reads when scout flag is on", async () => {
  await withExperimentalScout(true, async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await load(tmp.path, (svc) => svc.get("research"))
        expect(research).toBeDefined()
        expect(research?.mode).toBe("subagent")
        expect(evalPerm(research, "repo_clone")).toBe("allow")
        expect(evalPerm(research, "repo_overview")).toBe("allow")
        expect(evalPerm(research, "edit")).toBe("deny")
        expect(
          Permission.evaluate(
            "external_directory",
            path.join(Global.Path.repos, "github.com", "owner", "repo", "README.md"),
            research!.permission,
          ).action,
        ).toBe("allow")
      },
    })
  })
})

test("reference config is exposed through research context instead of extra subagents", async () => {
  await withExperimentalScout(true, async () => {
    await using tmp = await tmpdir({
      config: {
        reference: {
          effect: "github.com/effect/effect-smol",
          effectDev: {
            repository: "https://github.com/effect/effect-smol",
            branch: "dev",
          },
          effectFull: {
            repository: "Effect-TS/effect",
            branch: "main",
          },
          localdocs: "../docs",
          localdocsFull: {
            path: "../local-docs",
          },
        },
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const research = await load(tmp.path, (svc) => svc.get("research"))
        expect(research).toBeDefined()
        expect(research?.prompt).toContain("## Reference Extension")
        expect(research?.prompt).toContain("@effect")
        expect(research?.prompt).toContain("@effectDev")
        expect(research?.prompt).toContain("@effectFull")
        expect(research?.prompt).toContain("@localdocs")
        expect(research?.prompt).toContain("@localdocsFull")
        expect((await load(tmp.path, (svc) => svc.get("effect")))).toBeUndefined()
        expect((await load(tmp.path, (svc) => svc.get("effectDev")))).toBeUndefined()
        expect((await load(tmp.path, (svc) => svc.get("effectFull")))).toBeUndefined()
        expect((await load(tmp.path, (svc) => svc.get("localdocs")))).toBeUndefined()
        expect((await load(tmp.path, (svc) => svc.get("localdocsFull")))).toBeUndefined()
        expect(
          Permission.evaluate(
            "external_directory",
            path.join(path.resolve(tmp.path, "../docs"), "README.md"),
            research!.permission,
          ).action,
        ).toBe("allow")
        expect(
          Permission.evaluate(
            "external_directory",
            path.join(path.resolve(tmp.path, "../local-docs"), "README.md"),
            research!.permission,
          ).action,
        ).toBe("allow")
      },
    })
  })
})

test("writer agent denies todo tools", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const writer = await load(tmp.path, (svc) => svc.get("writer"))
      expect(writer).toBeDefined()
      expect(writer?.mode).toBe("subagent")
      expect(writer?.hidden).toBeUndefined()
      expect(evalPerm(writer, "todowrite")).toBe("deny")
    },
  })
})

test("tester agent only edits test files and cannot persist lessons/changelog", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const tester = await load(tmp.path, (svc) => svc.get("tester"))
      expect(tester).toBeDefined()
      expect(tester?.mode).toBe("subagent")
      if (!tester) return

      expect(Permission.evaluate("edit", "src/main.ts", tester.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "src/main.test.ts", tester.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", "src/main.spec.ts", tester.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", "src/__tests__/main.ts", tester.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", "src/test/main.ts", tester.permission).action).toBe("allow")

      expect(evalPerm(tester, "lesson_write")).toBe("deny")
      expect(evalPerm(tester, "changelog_append")).toBe("deny")
      expect(evalPerm(tester, "bash")).toBe("allow")
      expect(evalPerm(tester, "read")).toBe("allow")
      expect(evalPerm(tester, "glob")).toBe("allow")
      expect(evalPerm(tester, "grep")).toBe("allow")
    },
  })
})

test("compaction agent denies all permissions", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const compaction = await load(tmp.path, (svc) => svc.get("compaction"))
      expect(compaction).toBeDefined()
      expect(compaction?.hidden).toBe(true)
      expect(evalPerm(compaction, "bash")).toBe("deny")
      expect(evalPerm(compaction, "edit")).toBe("deny")
      expect(evalPerm(compaction, "read")).toBe("deny")
    },
  })
})

test("custom agent from config creates new agent", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const custom = await load(tmp.path, (svc) => svc.get("my_custom_agent"))
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    },
  })
})

test("custom agent config overrides native agent properties", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: {
          model: "anthropic/claude-3",
          description: "Custom orchestrator agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(build).toBeDefined()
      expect(String(build?.model?.providerID)).toBe("anthropic")
      expect(String(build?.model?.modelID)).toBe("claude-3")
      expect(build?.description).toBe("Custom orchestrator agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    },
  })
})

test("agent disable removes agent from list", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        planner: { disable: true },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const planner = await load(tmp.path, (svc) => svc.get("planner"))
      expect(planner).toBeUndefined()
      const agents = await load(tmp.path, (svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("planner")
    },
  })
})

test("agent permission config merges with defaults", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(build).toBeDefined()
      // Specific pattern is denied
      expect(Permission.evaluate("bash", "rm -rf *", build!.permission).action).toBe("deny")
      // Orchestrator defaults are preserved
      expect(evalPerm(build, "edit")).toBe("deny")
      expect(evalPerm(build, "task")).toBe("allow")
    },
  })
})

test("global permission config applies to all agents", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        bash: "deny",
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(build).toBeDefined()
      expect(evalPerm(build, "bash")).toBe("deny")
    },
  })
})

test("agent steps/maxSteps config sets steps property", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        primary_custom: { steps: 50, mode: "primary" },
        orchestrator: { maxSteps: 100 },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const primaryCustom = await load(tmp.path, (svc) => svc.get("primary_custom"))
      const plan = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(primaryCustom?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    },
  })
})

test("agent mode can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        planner: { mode: "primary" },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const planner = await load(tmp.path, (svc) => svc.get("planner"))
      expect(planner?.mode).toBe("primary")
    },
  })
})

test("agent name can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: { name: "Builder" },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(build?.name).toBe("Builder")
    },
  })
})

test("agent prompt can be set from config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: { prompt: "Custom system prompt" },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(build?.prompt).toBe("Custom system prompt")
    },
  })
})

test("unknown agent properties are placed into options", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    },
  })
})

test("agent options merge correctly", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    },
  })
})

test("multiple custom agents can be defined", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const agentA = await load(tmp.path, (svc) => svc.get("agent_a"))
      const agentB = await load(tmp.path, (svc) => svc.get("agent_b"))
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    },
  })
})

test("Agent.list keeps the default agent first and sorts the rest by name", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "orchestrator",
      agent: {
        zebra: {
          description: "Zebra",
          mode: "subagent",
        },
        alpha: {
          description: "Alpha",
          mode: "subagent",
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const names = (await load(tmp.path, (svc) => svc.list())).map((a) => a.name)
      expect(names[0]).toBe("orchestrator")
      expect(names.slice(1)).toEqual(names.slice(1).toSorted((a, b) => a.localeCompare(b)))
    },
  })
})

test("Agent.get returns undefined for non-existent agent", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const nonExistent = await load(tmp.path, (svc) => svc.get("does_not_exist"))
      expect(nonExistent).toBeUndefined()
    },
  })
})

test("default permission includes doom_loop and external_directory as ask", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(evalPerm(build, "doom_loop")).toBe("deny")
      expect(evalPerm(build, "external_directory")).toBe("ask")
    },
  })
})

test("webfetch is allowed by default", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(evalPerm(build, "webfetch")).toBe("deny")
    },
  })
})

test("legacy tools config converts to permissions", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    },
  })
})

test("legacy tools config maps write/edit/patch to edit permission", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: {
          tools: {
            write: false,
          },
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(evalPerm(build, "edit")).toBe("deny")
    },
  })
})

test("Truncate.GLOB is allowed even when user denies external_directory globally", async () => {
  const { Truncate } = await import("../../src/tool/truncate")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    },
  })
})

test("global tmp directory children are allowed for external_directory", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(
        Permission.evaluate("external_directory", path.join(Global.Path.tmp, "scratch"), build!.permission).action,
      ).toBe("allow")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("ask")
    },
  })
})

test("Truncate.GLOB is allowed even when user denies external_directory per-agent", async () => {
  const { Truncate } = await import("../../src/tool/truncate")
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    },
  })
})

test("explicit Truncate.GLOB deny is respected", async () => {
  const { Truncate } = await import("../../src/tool/truncate")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.GLOB]: "deny",
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
    },
  })
})

test("skill directories are allowed for external_directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".codemate", "skill", "perm-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
      )
    },
  })

  const home = process.env.codemate_TEST_HOME
  process.env.codemate_TEST_HOME = tmp.path

  try {
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await load(tmp.path, (svc) => svc.get("orchestrator"))
        const skillDir = path.join(tmp.path, ".codemate", "skill", "perm-skill")
        const target = path.join(skillDir, "reference", "notes.md")
        expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("allow")
      },
    })
  } finally {
    process.env.codemate_TEST_HOME = home
  }
})

test("defaultAgent returns orchestrator when no default_agent config", async () => {
  await using tmp = await tmpdir()
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("orchestrator")
    },
  })
})

test("defaultAgent respects default_agent config set to orchestrator", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "orchestrator",
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("orchestrator")
    },
  })
})

test("defaultAgent respects default_agent config set to custom agent with mode all", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("my_custom")
    },
  })
})

test("defaultAgent throws when default_agent points to subagent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "planner",
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow('default agent "planner" is a subagent')
    },
  })
})

test("defaultAgent throws when default_agent points to hidden agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "compaction",
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow('default agent "compaction" is hidden')
    },
  })
})

test("defaultAgent throws when default_agent points to non-existent agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "does_not_exist",
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow(
        'default agent "does_not_exist" not found',
      )
    },
  })
})

test("defaultAgent returns visible custom primary when orchestrator is disabled", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: { disable: true },
        primary_custom: { mode: "primary" },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await load(tmp.path, (svc) => svc.defaultAgent())
      expect(agent).toBe("primary_custom")
    },
  })
})

test("defaultAgent throws when all primary agents are disabled", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        orchestrator: { disable: true },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(load(tmp.path, (svc) => svc.defaultAgent())).rejects.toThrow("no primary visible agent found")
    },
  })
})
