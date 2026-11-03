// Code shown on the homepage: A one-file bot that answers !ping through a messageCreate handler. The starter that fluxerly init writes
// is in projects/sdk/examples/starter and exports its options for a test

export interface Sample {
    // Label of the tab that shows it
    label: string
    filename: string
    code: string
}

export const starterSamples: readonly Sample[] = [
    {
        label: "JavaScript",
        filename: "bot.js",
        code: `import { runBot } from "@neontechspace/fluxerly"

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
`,
    },
    {
        label: "TypeScript",
        filename: "bot.ts",
        code: `import { runBot } from "@neontechspace/fluxerly"

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
`,
    },
    {
        label: "Effect",
        filename: "bot.ts",
        code: `import { Effect } from "effect"
import { runBot } from "@neontechspace/fluxerly/effect"

const program = runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return Effect.void
            // A failed reply is reported to the log without stopping the bot
            return reply("Pong!")
        },
    },
})

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await Effect.runPromiseExit(program)
`,
    },
]

// The homepage's first bot, the same handler without its comments
export const firstBot = `import { runBot } from "@neontechspace/fluxerly"

await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    events: {
        messageCreate: ({ message, reply }) => {
            if (message.content !== "!ping") return
            return reply("Pong!")
        },
    },
})`

// Built from the declared shapes of createClient, client.on, messages.reply and client.run
export const clientApp = `import { createClient } from "@neontechspace/fluxerly"

const stop = new AbortController()
process.once("SIGINT", () => stop.abort())

await using client = createClient({
    token: process.env.FLUXER_BOT_TOKEN,
})
client.on("messageCreate", (message, signal) => {
    if (message.author.isBot) return
    if (message.content !== "!ping") return
    return client.messages.reply(message, "Pong!", { signal })
})
const result = await client.run({ signal: stop.signal })
if (result.isErr() && result.error._tag !== "CancelledError") {
    console.error(result.error.message)
    process.exitCode = 1
}`

// The FluxerClient example from the SDK's declarations, with shorter lines
export const effectLayer = `import { Config, Effect } from "effect"
import { FluxerClient } from "@neontechspace/fluxerly/effect"

const program = Effect.gen(function* () {
    const client = yield* FluxerClient
    yield* client.on("messageCreate", (message) =>
        message.content === "!ping"
            ? client.messages.reply(message, "Pong!")
            : Effect.void,
    )
    yield* client.run()
})

const client = FluxerClient.layerConfig({
    token: Config.Redacted("FLUXER_BOT_TOKEN"),
})

export const main = program.pipe(
    Effect.scoped,
    Effect.provide(client),
)`

// Index of the first line that contains the text, for line highlights
export function lineOf(code: string, text: string): number {
    return code.split("\n").findIndex((line) => line.includes(text))
}
