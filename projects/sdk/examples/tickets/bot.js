import { ChannelType, Permissions, format, guards, orThrow, runBot } from "@neontechspace/fluxerly"

function requiredEnv(name) {
    const value = process.env[name]
    if (!value) throw new Error(`Set the ${name} environment variable`)
    return value
}

const categoryId = requiredEnv("TICKET_CATEGORY_ID")
const staffRoleId = requiredEnv("TICKET_STAFF_ROLE_ID")
const access = Permissions.ViewChannel | Permissions.SendMessages | Permissions.ReadMessageHistory
let botUserId = ""

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    processSignals: true,
    onError: (report) => console.error(report.describe()),
    setup: async (client) => {
        botUserId = orThrow(await client.users.fetchSelf()).id
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
                                { id: botUserId, type: "member", allow: access, deny: 0n },
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
