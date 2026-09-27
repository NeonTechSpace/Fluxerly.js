import { afterEach, expect, test, vi } from "vitest"
import type { ResolvedInstance } from "../../../src/index.js"
import { modes, setup } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

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

    const client = await setup(mode, { token, instance: { url: bootstrap } })
    const resolved = await settle<ResolvedInstance, unknown>(client.instance.resolve())
    const observed = {
        endpoints: resolved.endpoints,
        defaultAvatar: resolved.assets.defaultAvatar("0"),
        emoji: resolved.assets.emoji({ id: "1", animated: false }),
        channel: resolved.links.channel({ id: "20" }),
        self: await settle(client.users.fetchSelf()),
        inviteUrl: (await settle(client.invites.fetch("PrefixCode"))).url,
    }

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
    expect([...new Headers(requests[0]!.init.headers).keys()]).toEqual(["user-agent"])
    for (const request of requests.slice(1)) {
        expect(request.init.redirect).toBe("error")
        expect(new Headers(request.init.headers).get("authorization")).toBe(`Bot ${token}`)
    }
})
