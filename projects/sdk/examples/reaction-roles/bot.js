import { hierarchy, orThrow, runBot } from "@neontechspace/fluxerly"

function requiredEnv(name) {
    const value = process.env[name]
    if (!value) throw new Error(`Set the ${name} environment variable`)
    return value
}

const target = { channelId: requiredEnv("ROLE_CHANNEL_ID"), id: requiredEnv("ROLE_MESSAGE_ID") }
const roleId = requiredEnv("ROLE_ID")
const emoji = process.env.ROLE_EMOJI || "✅"
let guildId = ""
let botUserId = ""

async function setRole(client, userId, granted) {
    if (userId === botUserId) return
    const member = { guildId, userId }
    orThrow(await (granted ? client.members.addRole(member, roleId) : client.members.removeRole(member, roleId)))
}

// A failure that stops the bot, such as a rejected token, is logged and sets a failing exit code
await runBot({
    token: process.env.FLUXER_BOT_TOKEN,
    onError: (report) => console.error(report.describe()),
    // Check the configuration once before connecting, so a role the bot cannot assign stops it at startup
    setup: async (client) => {
        guildId = orThrow(await client.channels.fetch(target.channelId)).guildId
        const self = orThrow(await client.members.fetchSelf(guildId))
        botUserId = self.userId
        const roles = orThrow(await client.roles.fetchAll(guildId))
        const role = roles.find((candidate) => candidate.id === roleId)
        const botRoles = roles.filter((candidate) => self.roleIds.includes(candidate.id))
        if (!role || !botRoles.some((botRole) => hierarchy.isAbove(botRole, role)))
            throw new Error("ROLE_ID must name a role below the bot's highest role")
        // The bot's own reaction shows members which emoji to use
        orThrow(await client.messages.addReaction(target, emoji))
    },
    events: {
        messageReactionAdd: async ({ event, client }) => {
            if (event.id === target.id && event.emoji.name === emoji) await setRole(client, event.userId, true)
        },
        messageReactionRemove: async ({ event, client }) => {
            if (event.id === target.id && event.emoji.name === emoji) await setRole(client, event.userId, false)
        },
    },
})
