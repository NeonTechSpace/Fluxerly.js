// Compile-only check, run by the test typecheck: the services a native partitionReady hook requires are added to the
// requirements of runBot and createTestBot, like the handler's and the onError hook's
import { Context, Effect } from "effect"
import { runBot } from "../../src/effect.js"
import { createTestBot } from "../../src/effect-testing.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
type Requirements<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never

class Setups extends Context.Service<Setups, { readonly ready: (key: string) => Effect.Effect<void> }>()("Setups") {}

export function botRequiresHookServices() {
    const bot = runBot({
        token: "fixture-token",
        events: {
            messageCreate: {
                partition: "guild",
                handler: () => Effect.void,
                partitionReady: (key) => Setups.use((setups) => setups.ready(key)),
            },
        },
    })
    const required: Assert<Equal<Requirements<typeof bot>, Setups>> = true
    return required
}

export function botRequiresCommandHookServices() {
    const bot = runBot({
        token: "fixture-token",
        commands: {
            prefix: "!",
            partition: "guild",
            partitionReady: (key) => Setups.use((setups) => setups.ready(key)),
            commands: { ping: { execute: () => Effect.void } },
        },
    })
    const required: Assert<Equal<Requirements<typeof bot>, Setups>> = true
    return required
}

export function testBotRequiresCommandHookServices() {
    const bot = createTestBot({
        commands: {
            prefix: "!",
            partition: "guild",
            partitionReady: (key) => Setups.use((setups) => setups.ready(key)),
            commands: { ping: { execute: () => Effect.void } },
        },
    })
    const required: Assert<Equal<Exclude<Requirements<typeof bot>, import("effect").Scope.Scope>, Setups>> = true
    return required
}

export function testBotRequiresHookServices() {
    const bot = createTestBot({
        events: {
            messageCreate: {
                partition: "guild",
                handler: () => Effect.void,
                partitionReady: (key) => Setups.use((setups) => setups.ready(key)),
            },
        },
    })
    const required: Assert<Equal<Exclude<Requirements<typeof bot>, import("effect").Scope.Scope>, Setups>> = true
    return required
}
