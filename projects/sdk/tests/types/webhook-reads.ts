// Compile-only check, run by the test typecheck: Webhook reads take request options without an audit reason in both
// APIs, because Fluxer records audit reasons only for changes and the SDK rejects one on a read
import type { Client as DefaultClient } from "../../src/index.js"
import type { Client as NativeClient } from "../../src/effect.js"

export function defaultReads(client: DefaultClient) {
    void client.webhooks.fetch("1", { timeoutMs: 1_000 })
    void client.webhooks.fetchForChannel("1", { timeoutMs: 1_000 })
    void client.webhooks.fetchForGuild("1", { timeoutMs: 1_000 })
    // @ts-expect-error A read takes no audit reason
    void client.webhooks.fetch("1", { auditReason: "x" })
    // @ts-expect-error A read takes no audit reason
    void client.webhooks.fetchForChannel("1", { auditReason: "x" })
    // @ts-expect-error A read takes no audit reason
    void client.webhooks.fetchForGuild("1", { auditReason: "x" })
    // Changes still take one
    void client.webhooks.delete("1", { auditReason: "x" })
}

export function nativeReads(client: NativeClient) {
    void client.webhooks.fetch("1", { timeoutMs: 1_000 })
    void client.webhooks.fetchForChannel("1", { timeoutMs: 1_000 })
    void client.webhooks.fetchForGuild("1", { timeoutMs: 1_000 })
    // @ts-expect-error A read takes no audit reason
    void client.webhooks.fetch("1", { auditReason: "x" })
    // @ts-expect-error A read takes no audit reason
    void client.webhooks.fetchForChannel("1", { auditReason: "x" })
    // @ts-expect-error A read takes no audit reason
    void client.webhooks.fetchForGuild("1", { auditReason: "x" })
    void client.webhooks.delete("1", { auditReason: "x" })
}
