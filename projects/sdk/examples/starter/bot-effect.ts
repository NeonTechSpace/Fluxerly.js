import { Cause, Effect, Exit } from "effect"
import { runBot } from "@neontechspace/fluxerly/effect"

const program = runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.author.isBot || message.content !== "!ping") return Effect.void
            return reply({ content: "Pong!" }).pipe(
                Effect.catch((error) => Effect.sync(() => console.warn("Reply failed", { kind: error._tag }))),
            )
        },
    },
})

const exit = await Effect.runPromiseExit(program)
if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
    console.error("Bot stopped because an operation or cleanup failed")
    process.exitCode = 1
}
