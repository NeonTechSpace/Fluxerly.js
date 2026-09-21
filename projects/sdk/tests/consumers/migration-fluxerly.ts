import type { Client, Message } from "@neontechspace/fluxerly"

export function installFluxerlyVariant(client: Client, greeting: (userId: string) => Promise<string>) {
    return client.on("messageCreate", async (message: Message, signal) => {
        if (message.content !== "!hello") return
        const replied = await client.messages.reply(message, { content: await greeting(message.author.id) }, { signal })
        if (replied.isErr()) throw replied.error
    })
}

export async function readFluxerlyHistory(client: Client, channelId: string, maxItems: number) {
    const messages: Message[] = []
    for await (const item of client.messages.iterateHistory(channelId, { maxItems, pageSize: 100 })) {
        if (item.isErr()) throw item.error
        messages.push(item.value)
    }
    return messages
}

export async function kickFluxerlyMember(client: Client, guildId: string, userId: string, reason: string) {
    const kicked = await client.members.kick({ guildId, userId }, { auditReason: reason })
    if (kicked.isErr()) throw kicked.error
}

export async function refreshFluxerlyAttachment(client: Client, url: string) {
    const refreshed = await client.attachments.refreshUrls([url])
    if (refreshed.isErr()) throw refreshed.error
    const first = refreshed.value[0]
    if (!first) throw new Error("Attachment refresh returned no result")
    return first.refreshed
}

export function fluxerlyHealth(client: Client) {
    const diagnostics = client.diagnostics()
    return {
        gateway: diagnostics.state,
        gatewayPingMs: diagnostics.gatewayLatencyMs,
        cache: diagnostics.caches,
    }
}

export async function closeFluxerly(client: Client) {
    const closed = await client.shutdown()
    if (closed.isErr()) throw closed.error
}
