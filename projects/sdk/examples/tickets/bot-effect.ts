import { Data, Effect } from "effect"
import { ChannelType, Permissions, defineBot, format, guards, runBot } from "@neontechspace/fluxerly/effect"

// A missing or wrong setting fails setup, which stops the bot at startup with this message
class SettingError extends Data.TaggedError("SettingError")<{ readonly message: string }> {}

const requiredEnv = (name: string) =>
    Effect.suspend(() => {
        const value = process.env[name]
        return value ? Effect.succeed(value) : new SettingError({ message: `Set the ${name} environment variable` })
    })

const access = Permissions.ViewChannel | Permissions.SendMessages | Permissions.ReadMessageHistory
// Setup reads the required settings, so a test can import this file without them
let categoryId = ""
let staffRoleId = ""

export const bot = defineBot({
    onError: (report) => Effect.logError(report.describe()),
    // Setup runs before the bot connects, so a missing setting stops the bot at startup
    setup: () =>
        Effect.gen(function* () {
            categoryId = yield* requiredEnv("TICKET_CATEGORY_ID")
            staffRoleId = yield* requiredEnv("TICKET_STAFF_ROLE_ID")
        }),
    commands: {
        prefix: "!",
        commands: {
            ticket: {
                description: "Open a private channel with the staff",
                guard: guards.guildOnly(),
                // One attempt per member per minute, and the name check below keeps one open ticket per member
                cooldown: { durationMs: 60_000, per: "user" },
                execute: ({ client, message, reply }) =>
                    Effect.gen(function* () {
                        const guildId = message.guildId
                        if (guildId === undefined) return
                        const name = `ticket-${message.author.id}`
                        const channels = yield* client.channels.fetchAll(guildId)
                        const open = channels.find(
                            (channel) => channel.parentId === categoryId && channel.name === name,
                        )
                        if (open) return yield* reply(`A ticket is already open: ${format.channelMention(open.id)}`)
                        // The bot's own account, as Fluxer reported it when the bot connected, read without a request
                        const bot = yield* client.users.getSelf()
                        if (bot === undefined)
                            return yield* reply("The bot's own account is not known yet. Try again later")

                        const channel = yield* client.channels.create(guildId, {
                            type: ChannelType.Text,
                            name,
                            parentId: categoryId,
                            // Hide the channel from other members. The member, the staff role and the bot can see it, as can the owner and Administrators
                            permissionOverwrites: [
                                { id: guildId, type: "role", allow: 0n, deny: Permissions.ViewChannel },
                                { id: staffRoleId, type: "role", allow: access, deny: 0n },
                                { id: message.author.id, type: "member", allow: access, deny: 0n },
                                { id: bot.id, type: "member", allow: access, deny: 0n },
                            ],
                        })
                        yield* client.messages.send(channel.id, {
                            content: `${format.userMention(message.author.id)} Describe the problem here. Send !close when it is solved`,
                            allowedMentions: { users: [message.author.id] },
                        })
                        return yield* reply(`Ticket opened: ${format.channelMention(channel.id)}`)
                    }),
            },
            close: {
                description: "Delete this ticket channel",
                guard: guards.guildOnly(),
                execute: ({ client, message, reply }) =>
                    Effect.gen(function* () {
                        const channel = yield* client.channels.fetch(message.channelId)
                        // Only channels in the ticket category that follow the ticket naming can be deleted
                        if (channel.parentId !== categoryId || !channel.name?.startsWith("ticket-"))
                            return yield* reply("Send !close inside a ticket channel")
                        return yield* client.channels.delete(channel.id)
                    }),
            },
        },
    },
})

// Running this file starts the bot, while importing it from a test does not.
// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
if (import.meta.main)
    await Effect.runPromiseExit(runBot({ token: process.env.FLUXER_BOT_TOKEN, processSignals: true, ...bot }))
