// Verified, runnable SDK presets executed on the real @neontechspace/fluxerly + createTestBot runtime
import type { SandboxMode } from "../playground-runtime/protocol"

export interface PlaygroundPreset {
    readonly id: string
    readonly label: string
    readonly tagline: string
    readonly guide: string
    readonly mode: SandboxMode
    readonly filename: string
    readonly quickMessages: readonly string[]
    readonly code: string
}

export const playgroundPresets: readonly PlaygroundPreset[] = [
    {
        id: "commands",
        label: "Commands",
        tagline: "Typed arguments, quoted parsing and instant validation replies",
        guide: 'Send !ping or !ban oops below, then edit "Pong!" in bot.ts to watch it update live',
        mode: "default",
        filename: "bot.ts",
        quickMessages: ["!ping", "!ban <@42> 7 spam", "!ban oops", "!help"],
        code: `import { builders, colors, commands, defineBot } from "@neontechspace/fluxerly"

export default defineBot({
    commands: {
        prefix: "!",
        parse: commands.parseQuoted,
        commands: {
            ping: {
                description: "Reply with a live Fluxer embed",
                execute: ({ reply }) =>
                    reply({
                        content: "Pong!",
                        embeds: [
                            builders
                                .embed()
                                .title("Fluxerly.js Sandbox")
                                .description("Running the real SDK on an in-memory Fluxer gateway")
                                .color(colors.parse("#46e3ef"))
                                .field("Transport", "createTestBot", { inline: true })
                                .field("Network", "Zero external I/O", { inline: true })
                                .build(),
                        ],
                    }),
            },
            greet: {
                description: "Greet a quoted name",
                arguments: { name: { type: "text" } },
                execute: ({ values, reply }) => reply(\`Hello, \${values.name}!\`),
            },
            ban: {
                description: "Validate typed user mention, integer range and rest text",
                arguments: {
                    user: { type: "id", mention: "user" },
                    days: { type: "integer", min: 1, max: 30, optional: true },
                    reason: { type: "text", rest: true, optional: true },
                },
                execute: ({ values, reply }) =>
                    reply(\`Banned <@\${values.user}> for \${values.days ?? 7}d: \${values.reason ?? "No reason"}\`),
            },
            help: {
                description: "List registered commands automatically",
                execute: ({ sendHelp }) => sendHelp(),
            },
        },
    },
})
`,
    },
    {
        id: "results",
        label: "Results",
        tagline: "Inspect typed Result failures and describeError hints without crashes",
        guide: "Click 403, send !announce, then open Logs to see Fluxerly return a typed Result with a hint instead of crashing",
        mode: "default",
        filename: "results.ts",
        quickMessages: ["!announce Live in 1003", "!check"],
        code: `import { defineBot, describeError, errors } from "@neontechspace/fluxerly"

// Click 403 in the channel bar, then send !announce
export default defineBot({
    commands: {
        prefix: "!",
        commands: {
            announce: {
                description: "Send a message and inspect any Fluxer rejection as a Result",
                arguments: { text: { type: "text", rest: true } },
                execute: async ({ values, reply }) => {
                    const result = await reply(values.text)
                    if (result.isErr()) {
                        console.error(describeError(result.error))
                        console.log({
                            code: result.error.code,
                            apiCode: errors.apiCode(result.error),
                            retryable: errors.isRetryable(result.error),
                            outcome: errors.outcome(result.error),
                        })
                        return
                    }
                    console.log("Delivered message id:", result.value.id)
                },
            },
            check: {
                description: "Trigger a clean 404 on an unmatched channel fetch",
                execute: async ({ client, reply }) => {
                    const fetched = await client.channels.fetch("999999999")
                    if (fetched.isErr()) {
                        console.warn(describeError(fetched.error))
                        return reply(\`Not found: \${errors.isNotFound(fetched.error)} (\${fetched.error.code})\`)
                    }
                    return reply("Found channel")
                },
            },
        },
    },
})
`,
    },
    {
        id: "resilience",
        label: "429 & Resume",
        tagline: "Arm a real 429 or drop the gateway socket and watch automatic recovery",
        guide: "Click 429, send !ping to watch auto-retry, then send !status to see the counter increase",
        mode: "default",
        filename: "resilience.ts",
        quickMessages: ["!ping", "!status"],
        code: `import { builders, colors, defineBot } from "@neontechspace/fluxerly"

// Click 429 then !ping, then !status to see live recovery counters
export default defineBot({
    commands: {
        prefix: "!",
        commands: {
            ping: {
                description: "Send a reply (Fluxerly waits and retries automatically on HTTP 429)",
                execute: ({ reply }) => reply("Pong! Reply delivered cleanly"),
            },
            status: {
                description: "Report live SDK counters from client.diagnostics()",
                execute: ({ client, reply }) => {
                    const c = client.diagnostics().counters
                    const card = builders
                        .embed()
                        .title("Live SDK Diagnostics")
                        .color(colors.parse("#a57cff"))
                        .field("REST Retries", String(c.restRetries), { inline: true })
                        .field("Rate Limit Waits", String(c.rateLimitWaits), { inline: true })
                        .field("Reconnects", String(c.reconnects), { inline: true })
                        .field("Resumes", String(c.resumes), { inline: true })
                        .build()
                    console.log("Diagnostics counters:", c)
                    return reply({ embeds: [card] })
                },
            },
        },
    },
})
`,
    },
    {
        id: "embeds",
        label: "Builders",
        tagline: "Compose validated embeds, colors, mentions and relative timestamps",
        guide: "Send !release below, then tweak the color hex or fields in embeds.ts to preview live",
        mode: "default",
        filename: "embeds.ts",
        quickMessages: ['!release 1003.0.0 "Zero-backend browser sandbox"', "!mention <@42>"],
        code: `import { builders, colors, commands, defineBot, format, TimestampStyles } from "@neontechspace/fluxerly"

export default defineBot({
    commands: {
        prefix: "!",
        parse: commands.parseQuoted,
        commands: {
            release: {
                description: "Build a structured release announcement card",
                arguments: {
                    version: { type: "text" },
                    summary: { type: "text", rest: true },
                },
                execute: ({ values, reply }) => {
                    const card = builders
                        .embed()
                        .author({ name: "Fluxerly.js Releases" })
                        .title(\`Release \${values.version}\`)
                        .description(values.summary)
                        .color(colors.parse("#46e3ef"))
                        .field("Channel", "Stable", { inline: true })
                        .field("Published", format.timestamp(new Date(), TimestampStyles.RelativeTime), { inline: true })
                        .footer({ text: "Validated by EmbedBuilder" })
                        .build()
                    return reply({ content: "New release ready", embeds: [card] })
                },
            },
            mention: {
                description: "Parse and re-format a user mention safely",
                arguments: { user: { type: "id", mention: "user" } },
                execute: ({ values, reply }) =>
                    reply(\`Parsed user ID \${values.user} -> \${format.userMention(values.user)}\`),
            },
        },
    },
})
`,
    },
    {
        id: "effect",
        label: "Effect 4",
        tagline: "Run the native Effect 4 API with Effect.gen and typed failure handling",
        guide: "Send !ping, or click 403, send !ping, and open Logs to watch Effect.catch handle the typed error",
        mode: "effect",
        filename: "bot-effect.ts",
        quickMessages: ["!ping", '!echo "Hello Effect 4"'],
        code: `import { Effect } from "effect"
import { builders, colors, commands, defineBot, describeError } from "@neontechspace/fluxerly/effect"

// Try clicking 403 then !ping to watch Effect.catch handle the typed failure
export default defineBot({
    commands: {
        prefix: "!",
        parse: commands.parseQuoted,
        commands: {
            ping: {
                description: "Reply using Effect.gen and handle typed failures",
                execute: ({ reply }) =>
                    Effect.gen(function* () {
                        const card = builders
                            .embed()
                            .title("Effect 4 Runtime")
                            .description("Same Fluxerly engine with typed error channels and scopes")
                            .color(colors.parse("#a57cff"))
                            .build()
                        yield* reply({ content: "Effect Pong!", embeds: [card] })
                    }).pipe(
                        Effect.catch((error) =>
                            Effect.sync(() => {
                                console.error("Caught typed Effect error:")
                                console.error(describeError(error))
                            }),
                        ),
                    ),
            },
            echo: {
                description: "Echo quoted text through an Effect command handler",
                arguments: { text: { type: "text", rest: true } },
                execute: ({ values, reply }) => reply(\`Effect echoed: \${values.text}\`).pipe(Effect.asVoid),
            },
        },
    },
})
`,
    },
]

export function getPreset(id: string | undefined): PlaygroundPreset {
    return playgroundPresets.find((preset) => preset.id === id) ?? playgroundPresets[0]!
}
