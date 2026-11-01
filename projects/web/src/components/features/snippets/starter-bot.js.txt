import { runBot } from "@neontechspace/fluxerly"

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return
            // Returning the reply reports a failed send to the log
            return reply("Pong!")
        },
    },
})
