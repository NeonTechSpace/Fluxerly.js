import { Effect, Exit, Scope } from "effect"
import type { Result, ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"

const modes = ["default", "native"] as const
const bootstrap = "https://community.example"
const token = "qualification-token"

const discovery = {
    api_code_version: 7,
    endpoints: {
        api_public: "https://services.community.example/api-root",
        gateway: "wss://services.community.example/gateway-root",
        media: "https://services.community.example/media-root",
        static_cdn: "https://services.community.example/static-root",
        webapp: "https://services.community.example/app-root",
        invite: "https://services.community.example/invite-root",
    },
    features: { presigned_attachment_uploads: false },
}

const user = {
    id: "10",
    username: "fixture",
    discriminator: "0001",
    global_name: null,
    avatar: null,
    avatar_color: null,
    flags: 0,
    bot: true,
}

const invite = {
    code: "PrefixCode",
    type: 0,
    channel: { id: "100", type: 0, name: "general" },
    guild: { id: "200", name: "Guild" },
    inviter: { id: "300", username: "excluded" },
    presence_count: 1,
    member_count: 2,
    temporary: false,
    max_age: 86400,
}

async function settle<A>(value: ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) return Effect.runPromise(value)
    const result = await value
    if (result.isErr()) throw result.error
    return result.value
}

async function pure<A>(value: Result<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) return Effect.runPromise(value)
    if (value.isErr()) throw value.error
    return value.value
}

afterEach(() => vi.unstubAllGlobals())

test.each(modes)("%s preserves every advertised service prefix without duplicating the API version", async (mode) => {
    const requests: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
            requests.push({ url, init })
            if (url === `${bootstrap}/.well-known/fluxer`) return Response.json(discovery)
            if (url === "https://services.community.example/api-root/v1/users/@me") return Response.json(user)
            if (url === "https://services.community.example/api-root/v1/invites/PrefixCode")
                return Response.json(invite)
            throw Error(`Unexpected qualification request ${init.method} ${url}`)
        }),
    )

    const scope = Scope.makeUnsafe()
    const options = { token, instance: { url: bootstrap } }
    const observed =
        mode === "default"
            ? await (async () => {
                  const client = createClient(options)._unsafeUnwrap()
                  onTestFinished(async () => {
                      await client.shutdown()
                      await Effect.runPromise(Scope.close(scope, Exit.void))
                  })
                  const resolved = await settle(client.instance.resolve())
                  return {
                      endpoints: resolved.endpoints,
                      defaultAvatar: await pure(resolved.assets.defaultAvatar("0")),
                      emoji: await pure(resolved.assets.emoji({ id: "1", animated: false })),
                      channel: await pure(resolved.links.channel({ id: "20" })),
                      self: await settle(client.users.fetchSelf()),
                      inviteUrl: (await settle(client.invites.fetch("PrefixCode"))).url,
                  }
              })()
            : await (async () => {
                  const client = await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
                  onTestFinished(async () => {
                      await Effect.runPromise(client.shutdown())
                      await Effect.runPromise(Scope.close(scope, Exit.void))
                  })
                  const resolved = await settle(client.instance.resolve())
                  return {
                      endpoints: resolved.endpoints,
                      defaultAvatar: await pure(resolved.assets.defaultAvatar("0")),
                      emoji: await pure(resolved.assets.emoji({ id: "1", animated: false })),
                      channel: await pure(resolved.links.channel({ id: "20" })),
                      self: await settle(client.users.fetchSelf()),
                      inviteUrl: (await settle(client.invites.fetch("PrefixCode"))).url,
                  }
              })()

    expect(observed.endpoints).toEqual({
        apiPublic: "https://services.community.example/api-root",
        gateway: "wss://services.community.example/gateway-root",
        media: "https://services.community.example/media-root",
        staticCdn: "https://services.community.example/static-root",
        webapp: "https://services.community.example/app-root",
        invite: "https://services.community.example/invite-root",
    })
    expect(observed.defaultAvatar).toBe("https://services.community.example/static-root/avatars/0.png")
    expect(observed.emoji).toBe("https://services.community.example/media-root/emojis/1.webp")
    expect(observed.channel).toBe("https://services.community.example/app-root/channels/@me/20")
    expect(observed.self).toMatchObject({ id: "10", isBot: true })
    expect(observed.inviteUrl).toBe("https://services.community.example/invite-root/PrefixCode")

    expect(requests.map(({ url }) => url)).toEqual([
        `${bootstrap}/.well-known/fluxer`,
        "https://services.community.example/api-root/v1/users/@me",
        "https://services.community.example/api-root/v1/invites/PrefixCode",
    ])
    expect(requests[0]!.init).toMatchObject({ method: "GET", redirect: "manual" })
    expect(requests[0]!.init.headers).toBeUndefined()
    for (const request of requests.slice(1)) {
        expect(request.init.redirect).toBe("error")
        expect(new Headers(request.init.headers).get("authorization")).toBe(`Bot ${token}`)
    }
})
