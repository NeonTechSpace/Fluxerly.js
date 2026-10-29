import { Effect } from "effect"
import { defineBot, runBot } from "@neontechspace/fluxerly/effect"

// The bot's options without its token, so its test can run them through createTestBot without a token or a network
export const bot = defineBot({
    commands: {
        prefix: "!",
        commands: {
            // A failed reply is reported to the log without stopping the bot
            ping: { execute: ({ reply }) => reply("Pong!") },
        },
    },
})

// Running this file starts the bot, while importing it from a test does not.
// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
if (import.meta.main)
    await Effect.runPromiseExit(runBot({ token: process.env.FLUXER_BOT_TOKEN, processSignals: true, ...bot }))
