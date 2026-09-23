import { runBot } from "@neontechspace/fluxerly"

const token = process.env.FLUXER_BOT_TOKEN
if (!token) throw new Error("FLUXER_BOT_TOKEN is required")

try {
    const result = await runBot(
        { token },
        (client) => {
            const subscription = client.on("messageCreate", async (message, signal) => {
                if (message.author.isBot || message.content !== "!ping") return
                const sent = await client.messages.reply(message, { content: "Pong!" }, { signal })
                if (sent.isErr()) console.warn("Reply failed", { kind: sent.error._tag })
            })
            if (subscription.isErr()) throw subscription.error
            return [subscription.value]
        },
        { processSignals: true },
    )
    if (result.isErr()) throw result.error
} catch {
    console.error("Bot stopped because an operation or cleanup failed")
    process.exitCode = 1
}
