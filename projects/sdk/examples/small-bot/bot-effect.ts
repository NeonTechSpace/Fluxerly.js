import { Effect } from "effect"
import { builders, describeError, format, guards, runBot } from "@neontechspace/fluxerly/effect"

// Optional channel that receives welcome messages
const welcomeChannelId = process.env.WELCOME_CHANNEL_ID

const program = runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    // Handler and command failures arrive here instead of stopping the bot
    onError: (report) => {
        const source = report.command ? `Command ${report.command}` : `Handler ${report.event ?? report.kind}`
        return Effect.logError(`${source} failed:\n${describeError(report.error)}`)
    },
    setup: () =>
        welcomeChannelId
            ? Effect.void
            : Effect.logInfo("WELCOME_CHANNEL_ID is not set, so the bot sends no welcome messages"),
    events: {
        guildMemberAdd: ({ event: member, client }) =>
            Effect.gen(function* () {
                if (!welcomeChannelId || member.isBot) return
                const channel = yield* client.channels.fetch(welcomeChannelId)
                if (channel.guildId !== member.guildId) return
                yield* client.messages.send(welcomeChannelId, {
                    content: `Welcome, ${format.userMention(member.userId)}!`,
                    allowedMentions: { users: [member.userId] },
                })
            }),
    },
    commands: {
        prefix: "!",
        commands: {
            help: {
                description: "List the commands",
                // The first page holds up to 2,000 characters, enough for this bot's commands
                execute: ({ help, reply }) => reply(help()[0] ?? "No commands"),
            },
            ping: {
                description: "Check that the bot is online",
                execute: ({ reply }) => reply("Pong!"),
            },
            greet: {
                description: "Greet someone by name",
                arguments: { name: { type: "text", rest: true } },
                cooldown: { durationMs: 5_000, per: "user" },
                execute: ({ values, reply }) => reply(`Hello, ${values.name}!`),
            },
            announce: {
                description: "Post an announcement card",
                arguments: { text: { type: "text", rest: true } },
                guard: guards.requirePermissions(["ManageMessages"]),
                execute: ({ message, values, reply }) => {
                    const card = builders
                        .embed()
                        .title("Announcement")
                        .description(values.text)
                        .color("#3b82f6")
                        .footer({ text: `Posted by ${message.author.username}` })
                    return reply({ embeds: [card] })
                },
            },
        },
    },
})

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await Effect.runPromiseExit(program)
