import { builders, format, orThrow, runBot } from "@neontechspace/fluxerly"

function requiredEnv(name) {
    const value = process.env[name]
    if (!value) throw new Error(`Set the ${name} environment variable`)
    return value
}

const channelId = requiredEnv("WELCOME_CHANNEL_ID")
// Optional role that every new member receives
const roleId = process.env.WELCOME_ROLE_ID || undefined
let guildId = ""

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    onError: (report) => console.error(report.describe()),
    // Setup runs before the bot connects, so a wrong channel ID stops the bot at startup
    setup: async (client) => {
        guildId = orThrow(await client.channels.fetch(channelId)).guildId
    },
    events: {
        guildMemberAdd: async ({ event: member, client }) => {
            if (member.guildId !== guildId || member.isBot) return
            const embed = builders
                .embed()
                .title("Welcome!")
                .description("Read the rules, pick a nickname and say hello")
                .color(0x8b7cf8)
            orThrow(
                await client.messages.send(channelId, {
                    content: `Welcome, ${format.userMention(member.userId)}!`,
                    embeds: [embed],
                    // Mentions notify nobody unless allowed explicitly
                    allowedMentions: { users: [member.userId] },
                }),
            )
            if (roleId === undefined) return
            // Returning the Result reports a failed role grant to onError
            return client.members.addRole({ guildId, userId: member.userId }, roleId)
        },
    },
})
