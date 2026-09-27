import { Effect } from "effect"
import { runBot } from "@neontechspace/fluxerly/effect"

const program = runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.author.isBot || message.content !== "!ping") return Effect.void
            // A failed reply is reported to the log without stopping the bot
            return reply("Pong!")
        },
    },
})

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await Effect.runPromiseExit(program)
