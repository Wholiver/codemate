import type { Hooks } from "@codemate-ai/plugin"
import { Context, Effect, Layer } from "effect"

type State = {
  hooks: Hooks[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@codemate/Plugin") {}

const state: State = { hooks: [] }

export const layer = Layer.succeed(
  Service,
  Service.of({
    trigger: Effect.fn("Plugin.trigger")(<
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(_name: Name, _input: Input, output: Output) => Effect.succeed(output)),
    list: Effect.fn("Plugin.list")(() => Effect.succeed(state.hooks)),
    init: Effect.fn("Plugin.init")(() => Effect.void),
  }),
)

export const defaultLayer = layer

export * as Plugin from "."
