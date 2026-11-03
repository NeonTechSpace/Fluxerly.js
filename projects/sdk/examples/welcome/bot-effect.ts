import { Data, Effect } from "effect"
import { builders, defineBot, format, runBot } from "@neontechspace/fluxerly/effect"

// A missing or wrong setting fails setup, which stops the bot at startup with this message
class SettingError extends Data.TaggedError("SettingError")<{ readonly message: string }> {}

const requiredEnv = (name: string) =>
    Effect.suspend(() => {
        const value = process.env[name]
        return value ? Effect.succeed(value) : new SettingError({ message: `Set the ${name} environment variable` })
    })

// Optional role that every new member receives
const roleId = process.env.WELCOME_ROLE_ID || undefined
// Setup reads the channel, so a test can import this file without the setting
let channelId = ""
let guildId = ""

export const bot = defineBot({
    onError: (report) => Effect.logError(report.describe()),
    // Setup runs before the bot connects, so a missing or wrong channel ID stops the bot at startup
    setup: (client) =>
        Effect.gen(function* () {
            channelId = yield* requiredEnv("WELCOME_CHANNEL_ID")
            guildId = (yield* client.channels.fetch(channelId)).guildId
        }),
    events: {
        guildMemberAdd: ({ event: member, client }) =>
            Effect.gen(function* () {
                if (member.guildId !== guildId || member.isBot) return
                const embed = builders
                    .embed()
                    .title("Welcome!")
                    .description("Read the rules, pick a nickname and say hello")
                    .color(0x8b7cf8)
                yield* client.messages.send(channelId, {
                    content: `Welcome, ${format.userMention(member.userId)}!`,
                    embeds: [embed],
                    // Mentions notify nobody unless allowed explicitly
                    allowedMentions: { users: [member.userId] },
                })
                if (roleId === undefined) return
                // A failed role grant fails the handler, which reports it to onError
                yield* client.members.addRole({ guildId, userId: member.userId }, roleId)
            }),
    },
})

// Running this file starts the bot, while importing it from a test does not.
// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
if (import.meta.main)
    await Effect.runPromiseExit(runBot({ token: process.env.FLUXER_BOT_TOKEN, processSignals: true, ...bot }))
