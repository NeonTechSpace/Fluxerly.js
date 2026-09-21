import { Client, Events, Message } from "@fluxerjs/core"
import { runNonVoiceMigrationContract } from "./nonvoice-contract.js"

function messagePayload(id, content, authorId = "90") {
    return {
        id,
        channel_id: "20",
        guild_id: "10",
        content,
        author: { id: authorId, username: "migration_fixture", discriminator: "0000", avatar: null },
        attachments: [],
        embeds: [],
        mention_everyone: false,
        mention_roles: [],
        mentions: [],
        pinned: false,
        timestamp: "2026-09-22T00:00:00.000Z",
        tts: false,
        type: 0,
    }
}

const client = new Client({ cache: { messages: 10 } })
const sourceMessage = new Message(client, messagePayload("1", "!hello", "30"))
const historyRequests = []
let kickAttempts = 0
let nextKickFails = false
let closed = false

client.rest.post = async (_route, body) => messagePayload("40", body.content)
client.rest.get = async (route) => {
    const target = String(route)
    if (target === "/channels/20") {
        return {
            id: "20",
            type: 0,
            guild_id: "10",
            name: "migration",
            position: 0,
            permission_overwrites: [],
        }
    }
    if (target.startsWith("/channels/20/messages")) {
        const url = new URL(target, "https://migration.example.test")
        const before = url.searchParams.get("before")
        historyRequests.push(before)
        return before === "20"
            ? [messagePayload("10", "oldest")]
            : [messagePayload("30", "newest"), messagePayload("20", "older")]
    }
    if (target === "/guilds/10") {
        return {
            id: "10",
            name: "Migration fixture",
            icon: null,
            banner: null,
            owner_id: "90",
            afk_timeout: 300,
            features: [],
            verification_level: 0,
            mfa_level: 0,
            nsfw_level: 0,
            nsfw: false,
            explicit_content_filter: 0,
            default_message_notifications: 0,
            splash_card_alignment: 0,
            system_channel_flags: 0,
            content_warning_level: 0,
            disabled_operations: 0,
        }
    }
    throw new Error(`Unexpected core fixture GET ${target}`)
}
client.rest.delete = async (route) => {
    if (String(route) === "/guilds/10/members/30") {
        kickAttempts += 1
        if (nextKickFails) {
            nextKickFails = false
            throw new TypeError("fixture connection closed after dispatch")
        }
        return
    }
    throw new Error(`Unexpected core fixture DELETE ${route}`)
}

const adapter = {
    name: "core",
    capabilities: { attachmentRefresh: false },
    message: { id: "1", channelId: "20", content: "!hello", authorId: "30", source: sourceMessage },
    async reply(target, content) {
        await target.source.reply({ content, allowedMentions: { parse: [] } })
    },
    async history(channelId, maxItems) {
        const channel = await client.channels.fetch(channelId)
        if (!channel.isTextBased()) throw new Error("Expected a text channel")
        const ids = []
        let before
        while (ids.length < maxItems) {
            const page = await channel.messages.fetch({
                limit: Math.min(2, maxItems - ids.length),
                ...(before ? { before } : {}),
            })
            if (page.size === 0) break
            for (const item of page.values()) ids.push(item.id)
            before = ids.at(-1)
        }
        return ids
    },
    historyRequests() {
        return historyRequests
    },
    async kick(target, reason) {
        try {
            const guild = await client.guilds.fetch(target.guildId)
            await guild.kick(target.userId, reason)
            return { kind: "succeeded" }
        } catch {
            return { kind: "failed", outcome: "unknown" }
        }
    },
    failNextKick() {
        nextKickFails = true
    },
    kickAttempts() {
        return kickAttempts
    },
    async prepareAttachment() {
        return { kind: "unsupported", reason: "attachmentRefresh" }
    },
    health() {
        const stats = client.cache.stats()
        return {
            sdk: "core",
            gateway: client.isReady() ? "ready" : "notStarted",
            cachedMessages: stats.messages,
        }
    },
    async close() {
        await client.destroy()
        client.removeAllListeners(Events.MessageCreate)
        closed = true
    },
    closeState() {
        return closed && !client.isReady() && client.listenerCount(Events.MessageCreate) === 0 ? "closed" : "open"
    },
}

await runNonVoiceMigrationContract(adapter)
console.log("@fluxerjs/core migration contract passed")
