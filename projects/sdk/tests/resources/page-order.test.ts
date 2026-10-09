import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { AuditLogActions } from "../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"
import { expectErr, type Operation } from "../support/settle.js"

// Pages Fluxer returns in ID order are checked across items. Each item here is valid on its own, so a failure must name
// the order check rather than the last field the decoder read
async function open(mode: Mode) {
    if (mode === "default") {
        const test = createDefaultTestClient()
        onTestFinished(() => test.shutdown())
        return test
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
}

test.each(modes)("%s names the order check when page items arrive out of order", async (mode) => {
    const api = await open(mode)
    const member = (id: string) => api.fixtures.member({ user: api.fixtures.user({ id }) })
    const threadMember = (id: string) => ({
        id: "70",
        user_id: id,
        join_timestamp: "2026-10-08T12:00:00.000Z",
        flags: 0,
    })
    const reactionUser = (id: string) => ({ id, username: `user${id}` })
    const auditEntry = (id: string) => ({ id, action_type: AuditLogActions.RoleUpdate, user_id: "30", target_id: "50" })
    api.rest.respond("GET /guilds/1/members", { body: [member("42"), member("41")] })
    api.rest.respond("GET /channels/70/thread-members", { body: [threadMember("42"), threadMember("41")] })
    api.rest.respond("GET /users/@me/guilds", {
        body: [api.fixtures.guild({ id: "42" }), api.fixtures.guild({ id: "41" })],
    })
    api.rest.respond("GET /channels/2/messages/3/reactions/:emoji/users", {
        body: { items: [reactionUser("42"), reactionUser("41")], has_more: false, next_after: null },
    })
    api.rest.respond("GET /guilds/1/audit-logs", {
        body: {
            audit_log_entries: [auditEntry("100"), auditEntry("101")],
            users: [api.fixtures.user({ id: "30" })],
            webhooks: [],
        },
    })
    const operations: Operation<unknown, unknown>[] = [
        api.client.members.fetchPage("1"),
        api.client.threads.fetchMembers("70"),
        api.client.guilds.fetchPage(),
        api.client.messages.fetchReactionUsers({ channelId: "2", id: "3" }, "👍"),
        api.client.auditLogs.fetchPage("1", { userId: "30" }),
    ]
    for (const operation of operations)
        expect(await expectErr(operation)).toMatchObject({ reason: "response", details: { responseField: "order" } })
})
