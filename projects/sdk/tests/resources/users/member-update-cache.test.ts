import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Client, ClientOptions, DirectMessageChannel, User } from "../../../src/index.js"
import type { Client as NativeClient } from "../../../src/effect.js"
import { Opcode } from "../../../src/internal/protocol/gateway.js"
import { modes, setup, type Mode } from "../../support/both-apis.js"
import { startGatewayServer } from "../../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle } from "../../support/settle.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const user = (username = "old identity", id = "30") => ({
    id,
    username,
    discriminator: "0001",
    global_name: null,
    avatar: null,
    avatar_color: null,
    flags: 0,
})
const directMessage = () => ({ id: "10", type: 1, recipients: [user()] })
const memberUpdate = () => ({
    guild_id: "20",
    user: user("new identity"),
    roles: [],
    joined_at: "2026-01-01T00:00:00.000Z",
    nick: null,
    avatar: null,
    banner: null,
})

function rest(handler: (path: string) => Promise<Response>) {
    stubFetchWithHostedDiscovery((url) =>
        url.endsWith("/gateway/bot")
            ? Promise.resolve(Response.json({ url: "wss://gateway.fluxer.app" }))
            : handler(new URL(url).pathname),
    )
}

async function cachedClient(mode: Mode, cache: ClientOptions["cache"] = { users: true, directMessages: true }) {
    return (await setup(mode, { cache, gateway: { ignoredEvents: "auto" } })) as Client
}

type Observations = { user: User | undefined; directMessage: DirectMessageChannel | undefined }

async function observeMemberUpdate(mode: Mode, client: Client) {
    const handled = Promise.withResolvers<Observations>()
    const observe = async () => {
        try {
            handled.resolve({
                user: await settle(client.users.get("30")),
                directMessage: await settle(client.directMessages.get("10")),
            })
        } catch (error) {
            handled.reject(error)
        }
    }
    if (mode === "default") client.on("guildMemberUpdate", observe)
    else {
        const scope = Scope.makeUnsafe()
        onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
        await Effect.runPromise(
            (client as unknown as NativeClient)
                .on("guildMemberUpdate", () => Effect.promise(observe))
                .pipe(Scope.provide(scope)),
        )
    }
    return { handled: handled.promise }
}

test.each(modes)(
    "%s invalidates account and DM identity before member-update handlers without changing held snapshots",
    async (mode) => {
        const server = await startGatewayServer()
        rest(async (path) =>
            Response.json(
                path.startsWith("/v1/users/") ? user("old identity", path.split("/").at(-1)) : directMessage(),
            ),
        )
        const client = await cachedClient(mode)
        const oldUser = await settle(client.users.fetch("30"))
        const unrelatedUser = await settle(client.users.fetch("31"))
        const oldDm = await settle(client.directMessages.fetch("10"))
        expect(await settle(client.users.get("30"))).toBe(oldUser)
        expect(await settle(client.directMessages.get("10"))).toBe(oldDm)
        const { handled } = await observeMemberUpdate(mode, client)
        await settle(client.connect())

        server.dispatch("GUILD_MEMBER_UPDATE", memberUpdate())
        expect(await handled).toEqual({ user: undefined, directMessage: undefined })
        expect(await settle(client.users.get("31"))).toBe(unrelatedUser)
        expect(oldUser.username).toBe("old identity")
        expect(oldDm.recipients[0]?.username).toBe("old identity")
        expect(Object.isFrozen(oldUser) && Object.isFrozen(oldDm) && Object.isFrozen(oldDm.recipients[0])).toBe(true)

        rest(async (path) =>
            Response.json(
                path === "/v1/users/30"
                    ? user("new identity")
                    : { ...directMessage(), recipients: [user("new identity")] },
            ),
        )
        await settle(client.users.fetch("30"))
        await settle(client.directMessages.fetch("10"))
        expect((await settle(client.users.get("30")))?.username).toBe("new identity")
        expect((await settle(client.directMessages.get("10")))?.recipients[0]?.username).toBe("new identity")
    },
)

for (const kind of ["users", "directMessages"] as const)
    test.each(modes)("%s keeps member updates for the " + kind + " cache without a member subscriber", async (mode) => {
        const server = await startGatewayServer()
        rest(async (path) => Response.json(path === "/v1/users/30" ? user() : directMessage()))
        const client = await cachedClient(mode, { [kind]: true })
        if (kind === "users") await settle(client.users.fetch("30"))
        else await settle(client.directMessages.fetch("10"))
        await settle(client.connect())
        const ignored = server.commandsWithOp(Opcode.identify)[0]!.d.ignored_events as string[]
        expect(ignored).toContain("TYPING_START")
        expect(ignored).not.toContain("GUILD_MEMBER_UPDATE")

        server.deliverNow("GUILD_MEMBER_UPDATE", memberUpdate())
        expect(
            await settle(kind === "users" ? client.users.get("30") : client.directMessages.get("10")),
        ).toBeUndefined()
    })

for (const collection of [false, true])
    test.each(modes)(
        "%s fences older " + (collection ? "collection" : "targeted") + " REST identities across a member update",
        async (mode) => {
            const server = await startGatewayServer()
            const userStarted = Promise.withResolvers<void>()
            const dmStarted = Promise.withResolvers<void>()
            const release = Promise.withResolvers<void>()
            let delayed = false
            rest(async (path) => {
                const account = path === "/v1/users/30" || path === "/v1/users/@me"
                if (delayed) {
                    ;(account ? userStarted : dmStarted).resolve()
                    await release.promise
                }
                return Response.json(
                    account ? user() : path === "/v1/users/@me/channels" ? [directMessage()] : directMessage(),
                )
            })
            const client = await cachedClient(mode)
            await settle(client.users.fetch("30"))
            await settle(client.directMessages.fetch("10"))
            const { handled } = await observeMemberUpdate(mode, client)
            await settle(client.connect())
            delayed = true
            const reads = [
                settle(collection ? client.users.fetchSelf() : client.users.fetch("30")),
                settle(collection ? client.directMessages.fetchAll() : client.directMessages.fetch("10")),
            ]
            try {
                await Promise.all([userStarted.promise, dmStarted.promise])
                server.dispatch("GUILD_MEMBER_UPDATE", memberUpdate())
                expect(await handled).toEqual({ user: undefined, directMessage: undefined })
                release.resolve()
                await Promise.all(reads)
                expect(await settle(client.users.get("30"))).toBeUndefined()
                expect(await settle(client.directMessages.get("10"))).toBeUndefined()
            } finally {
                release.resolve()
                await Promise.allSettled(reads)
            }
        },
    )

test.each(modes)("%s invalidates identity caches when a member update is skipped as malformed", async (mode) => {
    const server = await startGatewayServer()
    rest(async (path) => Response.json(path === "/v1/users/30" ? user() : directMessage()))
    const client = await cachedClient(mode)
    await settle(client.users.fetch("30"))
    await settle(client.directMessages.fetch("10"))
    await settle(client.connect())

    server.deliverNow("GUILD_MEMBER_UPDATE", { ...memberUpdate(), roles: "invalid" })
    expect(await settle(client.users.get("30"))).toBeUndefined()
    expect(await settle(client.directMessages.get("10"))).toBeUndefined()
})
