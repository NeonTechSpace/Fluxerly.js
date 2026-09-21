import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"

const kind = process.argv[2]
assert.ok(kind === "default" || kind === "effect")
const adjacentCases = new URL("./conformance-reference-cases.json", import.meta.url)
const cases = JSON.parse(
    readFileSync(
        existsSync(adjacentCases) ? adjacentCases : new URL("../conformance-reference-cases.json", import.meta.url),
        "utf8",
    ),
)
const reference = cases.membersSetRoles
const operationRequests = []
const discovery = {
    api_code_version: 1,
    endpoints: {
        api_public: "https://api.fluxer.app",
        gateway: "wss://gateway.fluxer.app",
        media: "https://fluxerusercontent.com",
        static_cdn: "https://fluxerstatic.com",
        webapp: "https://fluxer.app",
        invite: "https://fluxer.gg",
    },
    features: { presigned_attachment_uploads: true },
}

globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
    if (url.href === "https://fluxer.app/.well-known/fluxer") return Response.json(discovery)
    const authorization = new Headers(init.headers).get("authorization")
    operationRequests.push({ method: init.method, path: url.pathname.replace(/^\/v1/, ""), authorization })
    const roles = JSON.parse(String(init.body)).roles
    return Response.json({
        user: { id: reference.target.userId, username: "packed-conformance", bot: false },
        roles,
        joined_at: "2026-09-08T12:00:00.000Z",
        nick: null,
    })
}

let shutdown
let setRoles
if (kind === "default") {
    const { createClient } = await import("@neontechspace/fluxerly")
    const client = createClient({ token: "fixture-only-not-a-credential" })._unsafeUnwrap()
    shutdown = async () => (await client.shutdown())._unsafeUnwrap()
    setRoles = async (roleIds) => {
        const result = await client.members.setRoles(reference.target, roleIds)
        if (result.isErr()) throw result.error
        return result.value
    }
} else {
    const { Effect, Exit, Scope } = await import("effect")
    const { createClient } = await import("@neontechspace/fluxerly/effect")
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createClient({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(scope)),
    )
    shutdown = async () => {
        await Effect.runPromise(client.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
    setRoles = (roleIds) => Effect.runPromise(client.members.setRoles(reference.target, roleIds))
}

try {
    const member = await setRoles(reference.acceptedRoleIds)
    assert.deepEqual(member.roleIds, reference.acceptedRoleIds)
    for (const roleId of reference.rejectedRoleIds)
        await assert.rejects(setRoles([roleId]), {
            _tag: "GuildOperationError",
            operation: "members.setRoles",
            reason: "input",
            outcome: "notDispatched",
        })
    await assert.rejects(setRoles(reference.schemaAcceptedHandlerRejectedRoleIds), {
        _tag: "GuildOperationError",
        operation: "members.setRoles",
        reason: "input",
        outcome: "notDispatched",
    })
    assert.equal(operationRequests.length, 1)
    assert.deepEqual(
        {
            method: operationRequests[0].method,
            path: operationRequests[0].path,
            authorizationPrefix: operationRequests[0].authorization?.slice(
                0,
                reference.request.authorizationPrefix.length,
            ),
        },
        reference.request,
    )
} finally {
    await shutdown()
}

console.log(`Packed ${kind} conformance reference passed`)
