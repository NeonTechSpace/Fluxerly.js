import { runBot } from "@neontechspace/fluxerly"

try {
    const result = await runBot({
        token: process.env.FLUXER_BOT_TOKEN,
        processSignals: true,
        events: {
            messageCreate: async ({ message, reply }) => {
                if (message.author.isBot || message.content !== "!ping") return
                const sent = await reply({ content: "Pong!" })
                if (sent.isErr()) console.warn("Reply failed", { kind: sent.error._tag })
            },
        },
    })
    if (result.isErr()) throw result.error
} catch {
    console.error("Bot stopped because an operation or cleanup failed")
    process.exitCode = 1
}
