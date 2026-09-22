import { Cause, Effect, Exit } from "effect"
import { commands } from "@neontechspace/fluxerly/effect"
import { runBot } from "./lifetime-effect.ts"

const token = process.env.FLUXER_BOT_TOKEN
if (!token) throw new Error("FLUXER_BOT_TOKEN is required")

const program = runBot({ token }, (client) =>
    Effect.gen(function* () {
        const router = yield* commands.create({ prefix: "!" })
        const registered = yield* router.registerMany({
            ping: {
                arguments: {},
                execute: ({ reply }) =>
                    reply({ content: "Pong!" }).pipe(
                        Effect.catch((error) => Effect.sync(() => console.warn("Reply failed", { kind: error._tag }))),
                    ),
            },
            about: {
                arguments: {},
                execute: ({ reply }) =>
                    reply({ content: "A Fluxer bot built with Fluxerly" }).pipe(
                        Effect.catch((error) => Effect.sync(() => console.warn("Reply failed", { kind: error._tag }))),
                    ),
            },
        })
        const attached = yield* registered.attach(client)
        return [attached]
    }),
)

const exit = await Effect.runPromiseExit(program)
if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
    console.error("Bot stopped because an operation or cleanup failed")
    process.exitCode = 1
}
