import { commands } from "@neontechspace/fluxerly"
import { runBot } from "./lifetime.js"

const token = process.env.FLUXER_BOT_TOKEN
if (!token) throw new Error("FLUXER_BOT_TOKEN is required")

try {
    await runBot({ token }, (client) => {
        const router = commands.create({ prefix: "!" })
        if (router.isErr()) throw router.error

        const registered = router.value.registerMany({
            ping: {
                arguments: {},
                execute: async ({ reply }) => {
                    const sent = await reply({ content: "Pong!" })
                    if (sent.isErr()) console.warn("Reply failed", { kind: sent.error._tag })
                },
            },
            about: {
                arguments: {},
                execute: async ({ reply }) => {
                    const sent = await reply({ content: "A Fluxer bot built with Fluxerly" })
                    if (sent.isErr()) console.warn("Reply failed", { kind: sent.error._tag })
                },
            },
        })
        if (registered.isErr()) throw registered.error

        const attached = registered.value.attach(client)
        if (attached.isErr()) throw attached.error
        return [attached.value]
    })
} catch {
    console.error("Bot stopped because an operation or cleanup failed")
    process.exitCode = 1
}
