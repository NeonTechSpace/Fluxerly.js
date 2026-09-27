// Compile-only check, run by the test typecheck: runBot's keyed commands infer each command's argument values,
// including defaults, custom parsers and member references, and handlers may return a reply's Result or Effect directly
import { Effect } from "effect"
import { guards, runBot, type MemberReference } from "../../src/index.js"
import { guards as nativeGuards, runBot as nativeRunBot } from "../../src/effect.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

export function defaultBot(token: string | undefined) {
    return runBot({
        token,
        commands: {
            prefix: "!",
            mentionPrefix: true,
            onReject: "reply",
            use: [async (_context, next) => next()],
            commands: {
                ping: { execute: ({ reply }) => reply("Pong") },
                roll: {
                    arguments: { sides: { type: "integer", min: 2, max: 100, default: 6 } },
                    cooldown: { durationMs: 5_000, per: "channel" },
                    execute: ({ values }) => {
                        const sides: Assert<Equal<typeof values.sides, number>> = true
                        return sides
                    },
                },
                kick: {
                    guard: [guards.guildOnly(), guards.requirePermissions(["KickMembers"])],
                    arguments: {
                        target: { type: "member" },
                        color: {
                            type: "custom",
                            parse: (token: string): number | undefined => (token === "red" ? 0xff0000 : undefined),
                            optional: true,
                        },
                        after: { type: "duration", optional: true },
                    },
                    execute: ({ values, client }) => {
                        const target: Assert<Equal<typeof values.target, MemberReference>> = true
                        const color: Assert<Equal<typeof values.color, number | undefined>> = true
                        const after: Assert<Equal<typeof values.after, number | undefined>> = true
                        void [target, color, after]
                        return client.members.kick(values.target)
                    },
                },
            },
        },
        events: { messageCreate: ({ message, reply }) => (message.content === "hi" ? reply("Hello") : undefined) },
    })
}

export function nativeBot(token: string | undefined) {
    return nativeRunBot({
        token,
        commands: {
            prefix: "!",
            onReject: "reply",
            commands: {
                ping: { execute: ({ reply }) => reply("Pong") },
                roll: {
                    guard: nativeGuards.guildOnly(),
                    arguments: { sides: { type: "integer", default: 6 } },
                    execute: ({ values }) => Effect.succeed(values.sides satisfies number),
                },
            },
        },
    })
}

// A bot without events or command services requires no services, so it can run directly
export const runnable: Effect.Effect<void, unknown, never> = nativeRunBot({ token: "fixture-only-not-a-credential" })

// A typo in one descriptor is reported on that descriptor's own line, and a sibling command keeps its inferred values
export function defaultTypo(token: string | undefined) {
    return runBot({
        token,
        commands: {
            prefix: "!",
            commands: {
                roll: {
                    arguments: {
                        // @ts-expect-error "int" is not an argument type, and the error names the valid types here
                        sides: { type: "int", default: 6 },
                    },
                    execute: () => undefined,
                },
                add: {
                    arguments: { n: { type: "integer" } },
                    execute: ({ values }) => {
                        const n: Assert<Equal<typeof values.n, number>> = true
                        return n
                    },
                },
            },
        },
    })
}

export function nativeTypo(token: string | undefined) {
    return nativeRunBot({
        token,
        commands: {
            prefix: "!",
            commands: {
                roll: {
                    arguments: {
                        // @ts-expect-error "int" is not an argument type, and the error names the valid types here
                        sides: { type: "int", default: 6 },
                    },
                    execute: () => Effect.void,
                },
                add: {
                    arguments: { n: { type: "integer" } },
                    execute: ({ values }) => Effect.succeed(values.n satisfies number),
                },
            },
        },
    })
}
