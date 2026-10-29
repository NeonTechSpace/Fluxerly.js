import { ChannelType, Permissions, defineBot, format, guards, orThrow, runBot } from "@neontechspace/fluxerly"

function requiredEnv(name: string) {
    const value = process.env[name]
    if (!value) throw new Error(`Set the ${name} environment variable`)
    return value
}

const access = Permissions.ViewChannel | Permissions.SendMessages | Permissions.ReadMessageHistory
// Setup reads the required settings, so a test can import this file without them
let categoryId = ""
let staffRoleId = ""

export const bot = defineBot({
    onError: (report) => console.error(report.describe()),
    // Setup runs before the bot connects, so a missing setting stops the bot at startup
    setup: () => {
        categoryId = requiredEnv("TICKET_CATEGORY_ID")
        staffRoleId = requiredEnv("TICKET_STAFF_ROLE_ID")
    },
    commands: {
        prefix: "!",
        commands: {
            ticket: {
                description: "Open a private channel with the staff",
                guard: guards.guildOnly(),
                // One attempt per member per minute, and the name check below keeps one open ticket per member
                cooldown: { durationMs: 60_000, per: "user" },
                execute: async ({ client, message, reply }) => {
                    const guildId = message.guildId
                    if (guildId === undefined) return
                    const name = `ticket-${message.author.id}`
                    const channels = orThrow(await client.channels.fetchAll(guildId))
                    const open = channels.find((channel) => channel.parentId === categoryId && channel.name === name)
                    if (open) return reply(`A ticket is already open: ${format.channelMention(open.id)}`)
                    // The bot's own account, as Fluxer reported it when the bot connected, read without a request
                    const bot = client.users.getSelf()
                    if (bot === undefined) return reply("The bot's own account is not known yet. Try again later")

                    const channel = orThrow(
                        await client.channels.create(guildId, {
                            type: ChannelType.Text,
                            name,
                            parentId: categoryId,
                            // Hide the channel from everyone except the member, the staff role and the bot
                            permissionOverwrites: [
                                { id: guildId, type: "role", allow: 0n, deny: Permissions.ViewChannel },
                                { id: staffRoleId, type: "role", allow: access, deny: 0n },
                                { id: message.author.id, type: "member", allow: access, deny: 0n },
                                { id: bot.id, type: "member", allow: access, deny: 0n },
                            ],
                        }),
                    )
                    orThrow(
                        await client.messages.send(channel.id, {
                            content: `${format.userMention(message.author.id)} Describe the problem here. Send !close when it is solved`,
                            allowedMentions: { users: [message.author.id] },
                        }),
                    )
                    return reply(`Ticket opened: ${format.channelMention(channel.id)}`)
                },
            },
            close: {
                description: "Delete this ticket channel",
                guard: guards.guildOnly(),
                execute: async ({ client, message, reply }) => {
                    const channel = orThrow(await client.channels.fetch(message.channelId))
                    // Only channels in the ticket category that follow the ticket naming can be deleted
                    if (channel.parentId !== categoryId || !channel.name?.startsWith("ticket-"))
                        return reply("Send !close inside a ticket channel")
                    return client.channels.delete(channel.id)
                },
            },
        },
    },
})

// Running this file starts the bot, while importing it from a test does not.
// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
if (import.meta.main) await runBot({ token: process.env.FLUXER_BOT_TOKEN, ...bot })
