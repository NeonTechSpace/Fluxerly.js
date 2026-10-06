import { builders, describeError, format, guards, runBot } from "@neontechspace/fluxerly"
// Optional channel that receives welcome messages
const welcomeChannelId = process.env.WELCOME_CHANNEL_ID
if (!welcomeChannelId) console.info("WELCOME_CHANNEL_ID is not set, so the bot sends no welcome messages")

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    // Handler and command failures arrive here instead of stopping the bot
    onError: (report) => {
        const source = report.command ? `Command ${report.command}` : `Handler ${report.event ?? report.kind}`
        console.error(`${source} failed:\n${describeError(report.error)}`)
    },
    events: {
        guildMemberAdd: async ({ event: member, client, signal }) => {
            if (!welcomeChannelId || member.isBot) return
            const channel = await client.channels.fetch(welcomeChannelId, { signal })
            // A returned Err is reported to onError like a thrown error
            if (channel.isErr()) return channel
            if (channel.value.guildId !== member.guildId) return
            return client.messages.send(
                welcomeChannelId,
                {
                    content: `Welcome, ${format.userMention(member.userId)}!`,
                    allowedMentions: { users: [member.userId] },
                },
                { signal },
            )
        },
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
