import type {
    Client,
    DefaultMessageAuditOperationOptions,
    MessageSearchChannel,
    WebhookClient,
} from "../../src/index.js"
import type {
    Client as NativeClient,
    MessageAuditOperationOptions,
    MessageSearchChannel as NativeMessageSearchChannel,
    WebhookClient as NativeWebhookClient,
} from "../../src/effect.js"

export const unnamedGroup: MessageSearchChannel = { id: "20", type: 3, name: null }
export const nativeUnnamedGroup: NativeMessageSearchChannel = { id: "20", type: 3, name: null }

export function auditedMessageMutations(client: Client, native: NativeClient) {
    const target = { id: "10", channelId: "20" }
    const options: DefaultMessageAuditOperationOptions = {
        auditReason: "Moderation fixture",
        signal: new AbortController().signal,
    }
    void client.messages.delete(target, options)
    void client.messages.deleteMany("20", ["10"], options)
    void client.messages.pin(target, options)
    void client.messages.unpin(target, options)
    const nativeOptions: MessageAuditOperationOptions = { auditReason: "Moderation fixture" }
    void native.messages.delete(target, nativeOptions)
    void native.messages.deleteMany("20", ["10"], nativeOptions)
    void native.messages.pin(target, nativeOptions)
    void native.messages.unpin(target, nativeOptions)
    // @ts-expect-error Native audited options use interruption, not an AbortSignal
    const signal: MessageAuditOperationOptions = { signal: new AbortController().signal }
    void signal
    // @ts-expect-error Fetch is not an audited message mutation
    void client.messages.fetch(target, { auditReason: "Not accepted" })
    // @ts-expect-error Native fetch is not an audited message mutation
    void native.messages.fetch(target, { auditReason: "Not accepted" })
    // @ts-expect-error Reaction operations are not audited message mutations
    void client.messages.clearReactions(target, { auditReason: "Not accepted" })
    // @ts-expect-error Native reactions are not audited message mutations
    void native.messages.clearReactions(target, { auditReason: "Not accepted" })
    // @ts-expect-error Sends do not accept audit reasons
    void client.messages.send("20", "Fixture", { auditReason: "Not accepted" })
    // @ts-expect-error Native sends do not accept audit reasons
    void native.messages.send("20", "Fixture", { auditReason: "Not accepted" })
}

export function webhookNonces(client: WebhookClient, native: NativeWebhookClient) {
    const target = { id: "10", channelId: "20" }
    for (const nonce of ["operation-42", 42]) {
        void client.send({ content: "Fixture", nonce })
        void native.send({ content: "Fixture", nonce })
        void client.send({ content: "Reply", nonce, messageReference: { type: "reply", target } })
        void native.send({ content: "Reply", nonce, messageReference: { type: "reply", target } })
        void client.send({ nonce, messageReference: { type: "forward", source: { source: target } } })
        void native.send({ nonce, messageReference: { type: "forward", source: { source: target } } })
    }
}
