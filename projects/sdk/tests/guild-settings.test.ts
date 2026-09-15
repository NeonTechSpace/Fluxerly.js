import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    createClient,
    GuildFeatureToggles,
    type Guild,
    type GuildEdit,
    type DefaultModerationOptions,
} from "../src/index.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../src/effect.js"
import { GuildFeatureToggles as NativeGuildFeatureToggles } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const

afterEach(() => vi.unstubAllGlobals())

test.each(modes)(
    "%s patches bot-permitted settings, projects the result and refreshes its guild cache",
    async (mode) => {
        const calls: { path: string; method: string; body: unknown; reason: string | null }[] = []
        let current = guild()
        rest((url, init) => {
            const body = init.body ? JSON.parse(String(init.body)) : undefined
            calls.push({
                path: new URL(url).pathname,
                method: init.method!,
                body,
                reason: new Headers(init.headers).get("X-Audit-Log-Reason"),
            })
            if (init.method === "GET") return Response.json(current)
            current = guild({
                name: "Renamed guild",
                icon: null,
                banner: null,
                splash: null,
                embed_splash: null,
                splash_card_alignment: 2,
                system_channel_id: "40",
                system_channel_flags: 1,
                afk_channel_id: "41",
                afk_timeout: 600,
                default_message_notifications: 1,
                verification_level: 4,
                nsfw: true,
                content_warning_level: 1,
                content_warning_text: "Adults only",
                explicit_content_filter: 2,
                features: ["BANNER", "FUTURE_FEATURE", "HIDE_OWNER_CROWN"],
                message_history_cutoff: "2026-09-09T00:00:00Z",
            })
            return Response.json(current)
        })
        const api = await setup(mode)
        const previous = await api.fetch()
        const updated = await api.edit(
            {
                name: "Renamed guild",
                icon: null,
                banner: null,
                splash: null,
                embedSplash: null,
                systemChannelId: "40",
                systemChannelFlags: 1,
                afkChannelId: "41",
                afkTimeoutSeconds: 600,
                defaultMessageNotifications: 1,
                verificationLevel: 4,
                nsfw: true,
                contentWarningLevel: 1,
                contentWarningText: "Adults only",
                explicitContentFilter: 2,
                splashCardAlignment: 2,
                featureToggles: ["HIDE_OWNER_CROWN"],
                messageHistoryCutoff: "2026-09-09T00:00:00Z",
            },
            { auditReason: "  settings migration  " },
        )
        expect(calls).toEqual([
            { path: "/v1/guilds/20", method: "GET", body: undefined, reason: null },
            {
                path: "/v1/guilds/20",
                method: "PATCH",
                body: {
                    name: "Renamed guild",
                    icon: null,
                    banner: null,
                    splash: null,
                    embed_splash: null,
                    system_channel_id: "40",
                    system_channel_flags: 1,
                    afk_channel_id: "41",
                    afk_timeout: 600,
                    default_message_notifications: 1,
                    verification_level: 4,
                    nsfw: true,
                    content_warning_level: 1,
                    content_warning_text: "Adults only",
                    explicit_content_filter: 2,
                    splash_card_alignment: 2,
                    features: ["HIDE_OWNER_CROWN"],
                    message_history_cutoff: "2026-09-09T00:00:00Z",
                },
                reason: "settings migration",
            },
        ])
        expect(previous.name).toBe("fixture")
        expect(updated).toEqual({
            id: "20",
            ownerId: "30",
            name: "Renamed guild",
            icon: null,
            banner: null,
            splash: null,
            embedSplash: null,
            splashCardAlignment: 2,
            systemChannelId: "40",
            systemChannelFlags: 1,
            afkChannelId: "41",
            afkTimeoutSeconds: 600,
            defaultMessageNotifications: 1,
            verificationLevel: 4,
            nsfw: true,
            contentWarningLevel: 1,
            contentWarningText: "Adults only",
            explicitContentFilter: 2,
            features: ["BANNER", "FUTURE_FEATURE", "HIDE_OWNER_CROWN"],
            messageHistoryCutoff: "2026-09-09T00:00:00Z",
        })
        expect(Object.isFrozen(updated) && Object.isFrozen(updated.features)).toBe(true)
        expect(await api.get()).toEqual(updated)
    },
)

test.each(modes)("%s sends only a complete desired toggle set without a hidden guild read", async (mode) => {
    const calls: { method: string; body: unknown }[] = []
    rest((_url, init) => {
        calls.push({ method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined })
        return Response.json(guild({ features: ["BANNER", "PROVIDER_MANAGED", "INVITES_DISABLED"] }))
    })
    const api = await setup(mode)
    const result = await api.edit({ featureToggles: ["INVITES_DISABLED"] })
    expect(calls).toEqual([{ method: "PATCH", body: { features: ["INVITES_DISABLED"] } }])
    expect(result.features).toEqual(["BANNER", "PROVIDER_MANAGED", "INVITES_DISABLED"])
})

test.each(modes)("%s enables, preserves and disables source-guild cloning opt-ins", async (mode) => {
    // Fluxer 4a285cbb117447ad714ec7b25df4b19c84902203, GuildOperationsService.computeUpdatedFeatures
    // Keep this wire-contract fixture independent of the SDK constants; the opt-in upstream check detects later drift
    const toggleable = new Set([
        "INVITES_DISABLED",
        "TEXT_CHANNEL_FLEXIBLE_NAMES",
        "DETACHED_BANNER",
        "CLONE_EMOJI_ENABLED",
        "CLONE_STICKER_ENABLED",
        "HIDE_OWNER_CROWN",
    ])
    const preserved = ["BANNER", "FUTURE_FEATURE", "CLONE_EMOJI_DISABLED", "CLONE_STICKER_DISABLED"]
    let features = [...preserved]
    const bodies: Record<string, unknown>[] = []
    rest((_url, init) => {
        expect(init.method).toBe("PATCH")
        const body = JSON.parse(String(init.body))
        bodies.push(body)
        if (body.features !== undefined) {
            const desired = new Set<string>(body.features)
            for (const feature of desired) expect(toggleable.has(feature)).toBe(true)
            features = [...features.filter((feature) => !toggleable.has(feature)), ...desired]
        }
        return Response.json(guild({ features, ...(body.name === undefined ? {} : { name: body.name }) }))
    })
    const api = await setup(mode)
    const toggles = mode === "default" ? GuildFeatureToggles : NativeGuildFeatureToggles
    const cloning = [toggles.CloneEmojiEnabled, toggles.CloneStickerEnabled]
    const enabled = await api.edit({ featureToggles: cloning })
    expect(enabled.features).toEqual([...preserved, "CLONE_EMOJI_ENABLED", "CLONE_STICKER_ENABLED"])
    expect(await api.get()).toEqual(enabled)
    expect((await api.edit({ name: "Renamed without changing features" })).features).toEqual(enabled.features)
    const kept = await api.edit({ featureToggles: [...cloning, toggles.HideOwnerCrown] })
    expect(kept.features).toEqual([...enabled.features!, "HIDE_OWNER_CROWN"])
    const emojiDisabled = await api.edit({ featureToggles: [toggles.CloneStickerEnabled, toggles.HideOwnerCrown] })
    expect(emojiDisabled.features).toEqual([...preserved, "CLONE_STICKER_ENABLED", "HIDE_OWNER_CROWN"])
    const disabled = await api.edit({ featureToggles: [] })
    expect(disabled.features).toEqual(preserved)
    expect(await api.get()).toEqual(disabled)
    expect(bodies).toEqual([
        { features: ["CLONE_EMOJI_ENABLED", "CLONE_STICKER_ENABLED"] },
        { name: "Renamed without changing features" },
        { features: ["CLONE_EMOJI_ENABLED", "CLONE_STICKER_ENABLED", "HIDE_OWNER_CROWN"] },
        { features: ["CLONE_STICKER_ENABLED", "HIDE_OWNER_CROWN"] },
        { features: [] },
    ])
})

test.each(modes)("%s accepts image data URIs with MIME parameters", async (mode) => {
    const bodies: unknown[] = []
    rest((_url, init) => {
        bodies.push(init.body ? JSON.parse(String(init.body)) : undefined)
        return Response.json(guild())
    })
    const api = await setup(mode)
    await api.edit({ icon: "data:image/png;charset=utf-8;base64,aGVsbG8=" })
    expect(bodies).toEqual([{ icon: "data:image/png;charset=utf-8;base64,aGVsbG8=" }])
})

test.each(modes)("%s rejects unsupported, malformed and empty guild-setting patches before dispatch", async (mode) => {
    let calls = 0
    rest(() => {
        calls++
        return Response.json(guild())
    })
    const api = await setup(mode)
    for (const input of [
        {},
        { description: "unsupported" },
        { mfaLevel: 1 },
        { systemChannelId: "not-an-id" },
        { systemChannelFlags: 2 },
        { afkTimeoutSeconds: 59 },
        { defaultMessageNotifications: 2 },
        { verificationLevel: 5 },
        { contentWarningLevel: 2 },
        { contentWarningText: "x".repeat(201) },
        { explicitContentFilter: -1 },
        { splashCardAlignment: 3 },
        { featureToggles: ["INVITES_DISABLED", "INVITES_DISABLED"] },
        { featureToggles: Array(1) },
        { featureToggles: ["BANNER"] },
        { featureToggles: ["CLONE_EMOJI_DISABLED"] },
        { featureToggles: ["CLONE_STICKER_DISABLED"] },
        { messageHistoryCutoff: "2026-09-09" },
        { messageHistoryCutoff: "2025-02-29T00:00:00Z" },
        { messageHistoryCutoff: "2024-04-31T00:00:00Z" },
        { name: "" },
        { icon: "not-an-image" },
    ])
        await expect(api.edit(input as GuildEdit)).rejects.toMatchObject({
            _tag: "GuildOperationError",
            operation: "guilds.edit",
            reason: "input",
            outcome: "notDispatched",
        })
    await expect(api.edit({ name: "valid" }, { auditReason: "\n" })).rejects.toMatchObject({ reason: "input" })
    expect(calls).toBe(0)
})

test.each(modes)("%s preserves valid UTC calendar cutoffs in requests and responses", async (mode) => {
    const bodies: unknown[] = []
    rest((_url, init) => {
        const body = JSON.parse(String(init.body))
        bodies.push(body)
        return Response.json(guild(body))
    })
    const api = await setup(mode)
    for (const value of ["2000-02-29T00:00:00Z", "2024-04-30T24:00:00Z", "2024-02-29T00:00:00.123456789Z"]) {
        expect((await api.edit({ messageHistoryCutoff: value })).messageHistoryCutoff).toBe(value)
        expect(bodies.at(-1)).toEqual({ message_history_cutoff: value })
    }
    let reads = 0
    const input = {
        get messageHistoryCutoff() {
            return reads++ === 0 ? "2024-02-29T00:00:00Z" : "2025-02-29T00:00:00Z"
        },
    }
    expect((await api.edit(input)).messageHistoryCutoff).toBe("2024-02-29T00:00:00Z")
    expect(reads).toBe(1)
    const calls = bodies.length
    await expect(api.edit(input)).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    expect(bodies).toHaveLength(calls)
})

test.each(modes)("%s snapshots bounded guild feature toggles from indexed values", async (mode) => {
    const bodies: unknown[] = []
    rest((_url, init) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json(guild())
    })
    const api = await setup(mode)
    const featureToggles = [GuildFeatureToggles.HideOwnerCrown]
    Object.defineProperty(featureToggles, Symbol.iterator, {
        value: () => {
            throw Error("Guild settings must not consume caller iterators")
        },
    })

    await api.edit({ featureToggles })
    expect(bodies).toEqual([{ features: ["HIDE_OWNER_CROWN"] }])

    let indexedReads = 0
    const invalid = ["HIDE_OWNER_CROWN"]
    Object.defineProperty(invalid, "0", {
        get: () => {
            indexedReads++
            return "unsupported"
        },
    })
    Object.defineProperty(invalid, Symbol.iterator, {
        value: () => {
            throw Error("Guild settings must reject indexed invalid values without iterating")
        },
    })
    await expect(api.edit({ featureToggles: invalid } as GuildEdit)).rejects.toMatchObject({
        _tag: "GuildOperationError",
        operation: "guilds.edit",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(indexedReads).toBe(1)
    expect(bodies).toHaveLength(1)
})

test.each(modes)(
    "%s fails a malformed guild settings response without accepting a partial projection",
    async (mode) => {
        rest(() => Response.json(guild({ content_warning_level: 4 })))
        const api = await setup(mode)
        await expect(api.edit({ contentWarningLevel: 1 })).rejects.toMatchObject({
            _tag: "GuildOperationError",
            operation: "guilds.edit",
            reason: "response",
            outcome: "unknown",
            status: 200,
        })
    },
)

const guild = (extra: Record<string, unknown> = {}) => ({
    id: "20",
    owner_id: "30",
    name: "fixture",
    features: ["BANNER", "FUTURE_FEATURE"],
    icon: null,
    banner: null,
    ...extra,
})

const unwrap = <A, E>(value: { isErr(): boolean; value?: A; error?: E }): A => {
    if (value.isErr()) throw value.error
    return value.value!
}

async function setup(mode: (typeof modes)[number]) {
    const cache = { guilds: { maxEntries: 10 } }
    const scope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? unwrap(createClient({ token: "fixture", cache })) : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "fixture", cache } as NativeClientOptions).pipe(Scope.provide(scope)),
              )
            : undefined
    onTestFinished(async () => {
        if (defaultApi) unwrap(await defaultApi.shutdown())
        if (native) await Effect.runPromise(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const run = async <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect)
    return {
        fetch: async () =>
            defaultApi
                ? unwrap(await defaultApi.guilds.fetch("20"))
                : native
                  ? run(native.guilds.fetch("20"))
                  : never(),
        get: async (): Promise<Guild | undefined> =>
            defaultApi ? unwrap(defaultApi.guilds.get("20")) : native ? run(native.guilds.get("20")) : never(),
        edit: async (input: GuildEdit, options?: DefaultModerationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.guilds.edit("20", input, options))
                : native
                  ? run(native.guilds.edit("20", input, options))
                  : never(),
    }
}

function rest(handler: (url: string, init: RequestInit) => Response) {
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) =>
        url.endsWith("/gateway/bot")
            ? Promise.resolve(Response.json({ url: "wss://gateway.fluxer.app" }))
            : Promise.resolve(handler(url, init)),
    )
}

function never(): never {
    throw Error("Test client was not created")
}
