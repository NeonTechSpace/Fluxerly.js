import { Cause, Effect, Exit } from "effect"
import { runBot } from "@neontechspace/fluxerly/effect"

const token = process.env.FLUXER_BOT_TOKEN
if (!token) throw new Error("FLUXER_BOT_TOKEN is required")

const program = runBot(
    { token },
    (client) =>
        Effect.gen(function* () {
            const subscription = yield* client.on("messageCreate", (message) => {
                if (message.author.isBot || message.content !== "!ping") return Effect.void
                return client.messages
                    .reply(message, { content: "Pong!" })
                    .pipe(
                        Effect.catch((error) => Effect.sync(() => console.warn("Reply failed", { kind: error._tag }))),
                    )
            })
            return [subscription]
        }),
    { processSignals: true },
)

const exit = await Effect.runPromiseExit(program)
if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
    console.error("Bot stopped because an operation or cleanup failed")
    process.exitCode = 1
}
