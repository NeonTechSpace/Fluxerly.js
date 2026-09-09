import { Effect, Exit } from "effect"
import type { Result } from "neverthrow"
import { afterEach, expect, test, vi } from "vitest"
import * as native from "../src/effect.js"
import * as defaultApi from "../src/index.js"

const userId = "1750000000000000000"
const guildId = "1750000000000000001"
const memberId = "1750000000000000002"
const expressionId = "1750000000000000003"

afterEach(() => vi.unstubAllGlobals())

function value<A, E>(result: Result<A, E>): A {
    if (!result.isOk()) throw result.error
    return result.value
}

async function nativeError(effect: Effect.Effect<unknown, unknown>): Promise<unknown> {
    const exit = await Effect.runPromiseExit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) throw Error("Expected native asset failure")
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (!failure || failure._tag !== "Fail") throw Error("Expected native asset failure")
    return failure.error
}

test("builds every hosted asset route through both public entries without fetching", async () => {
    let fetches = 0
    vi.stubGlobal("fetch", () => {
        fetches += 1
        throw Error("Asset helpers must not fetch")
    })
    const user = { id: userId, avatar: "avatar_hash" }
    const member = { guildId, userId, avatar: "member_hash", banner: "member_banner", profileFlags: 0 }
    const guild = {
        id: guildId,
        icon: "icon_hash",
        banner: "banner_hash",
        splash: "splash_hash",
        embedSplash: "embed_hash",
    }
    const animatedEmoji = { id: expressionId, animated: true }
    const animatedSticker = { id: expressionId, animated: true }

    expect(value(defaultApi.assets.avatar(user, { size: 256, format: defaultApi.AssetFormats.Webp }))).toBe(
        `https://fluxerusercontent.com/avatars/${userId}/avatar_hash.webp?size=256`,
    )
    expect(value(defaultApi.assets.defaultAvatar(userId))).toBe(
        `https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`,
    )
    expect(value(defaultApi.assets.displayAvatar({ id: userId, avatar: null }))).toBe(
        `https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`,
    )
    expect(value(defaultApi.assets.memberAvatar(member, { format: defaultApi.AssetFormats.Png }))).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/avatars/member_hash.png`,
    )
    expect(value(defaultApi.assets.memberBanner(member, { size: 480 }))).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/banners/member_banner.webp?size=480`,
    )
    expect(value(defaultApi.assets.displayMemberAvatar(user, member))).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/avatars/member_hash.webp`,
    )
    expect(value(defaultApi.assets.guildIcon(guild))).toBe(
        `https://fluxerusercontent.com/icons/${guildId}/icon_hash.webp`,
    )
    expect(value(defaultApi.assets.guildBanner(guild))).toBe(
        `https://fluxerusercontent.com/banners/${guildId}/banner_hash.webp`,
    )
    expect(value(defaultApi.assets.guildSplash(guild))).toBe(
        `https://fluxerusercontent.com/splashes/${guildId}/splash_hash.webp`,
    )
    expect(value(defaultApi.assets.guildEmbedSplash(guild))).toBe(
        `https://fluxerusercontent.com/embed-splashes/${guildId}/embed_hash.webp`,
    )
    expect(value(defaultApi.assets.emoji(animatedEmoji, { size: 512, format: defaultApi.AssetFormats.Gif }))).toBe(
        `https://fluxerusercontent.com/emojis/${expressionId}.gif?size=512&animated=true`,
    )
    expect(value(defaultApi.assets.sticker(animatedSticker, { size: 128 }))).toBe(
        `https://fluxerusercontent.com/stickers/${expressionId}.webp?size=128&animated=true`,
    )

    expect(await Effect.runPromise(native.assets.avatar(user, { size: 256, format: native.AssetFormats.Webp }))).toBe(
        `https://fluxerusercontent.com/avatars/${userId}/avatar_hash.webp?size=256`,
    )
    expect(await Effect.runPromise(native.assets.defaultAvatar(userId))).toBe(
        `https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`,
    )
    expect(await Effect.runPromise(native.assets.displayAvatar({ id: userId, avatar: null }))).toBe(
        `https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`,
    )
    expect(await Effect.runPromise(native.assets.memberAvatar(member))).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/avatars/member_hash.webp`,
    )
    expect(await Effect.runPromise(native.assets.memberBanner(member))).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/banners/member_banner.webp`,
    )
    expect(await Effect.runPromise(native.assets.displayMemberAvatar(user, member))).toBe(
        `https://fluxerusercontent.com/guilds/${guildId}/users/${userId}/avatars/member_hash.webp`,
    )
    expect(await Effect.runPromise(native.assets.guildIcon(guild))).toBe(
        `https://fluxerusercontent.com/icons/${guildId}/icon_hash.webp`,
    )
    expect(await Effect.runPromise(native.assets.guildBanner(guild))).toBe(
        `https://fluxerusercontent.com/banners/${guildId}/banner_hash.webp`,
    )
    expect(await Effect.runPromise(native.assets.guildSplash(guild))).toBe(
        `https://fluxerusercontent.com/splashes/${guildId}/splash_hash.webp`,
    )
    expect(await Effect.runPromise(native.assets.guildEmbedSplash(guild))).toBe(
        `https://fluxerusercontent.com/embed-splashes/${guildId}/embed_hash.webp`,
    )
    expect(await Effect.runPromise(native.assets.emoji(animatedEmoji, { format: native.AssetFormats.Apng }))).toBe(
        `https://fluxerusercontent.com/emojis/${expressionId}.apng?animated=true`,
    )
    expect(await Effect.runPromise(native.assets.sticker(animatedSticker))).toBe(
        `https://fluxerusercontent.com/stickers/${expressionId}.webp?animated=true`,
    )
    expect(fetches).toBe(0)
})

test("preserves missing versus unknown assets and uses only known display-avatar fallbacks", () => {
    const userWithoutAvatar = { id: userId, avatar: null }

    expect(value(defaultApi.assets.avatar(userWithoutAvatar))).toBeNull()
    expect(value(defaultApi.assets.memberAvatar({ guildId, userId }))).toBeUndefined()
    expect(value(defaultApi.assets.memberAvatar({ guildId, userId, avatar: null }))).toBeNull()
    expect(value(defaultApi.assets.memberBanner({ guildId, userId }))).toBeUndefined()
    expect(value(defaultApi.assets.guildIcon({ id: guildId }))).toBeUndefined()
    expect(value(defaultApi.assets.guildBanner({ id: guildId, banner: null }))).toBeNull()
    expect(
        value(
            defaultApi.assets.displayMemberAvatar(userWithoutAvatar, {
                guildId,
                userId,
                avatar: null,
                profileFlags: 0,
            }),
        ),
    ).toBe(`https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`)
    expect(
        value(
            defaultApi.assets.displayMemberAvatar(
                { id: userId, avatar: "global_hash" },
                {
                    guildId,
                    userId,
                    avatar: "member_hash",
                    profileFlags: defaultApi.GuildMemberProfileFlags.AvatarUnset,
                },
            ),
        ),
    ).toBe(`https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`)
    expect(
        value(
            defaultApi.assets.displayMemberAvatar(
                { id: userId, avatar: "global_hash" },
                { guildId, userId, profileFlags: defaultApi.GuildMemberProfileFlags.AvatarUnset },
            ),
        ),
    ).toBe(`https://fluxerstatic.com/avatars/${BigInt(userId) % 6n}.png`)
    expect(
        value(defaultApi.assets.displayMemberAvatar(userWithoutAvatar, { guildId, userId, avatar: null })),
    ).toBeUndefined()
    expect(
        value(defaultApi.assets.displayMemberAvatar(userWithoutAvatar, { guildId, userId, profileFlags: 0 })),
    ).toBeUndefined()
})

test("rejects invalid targets and unsafe animation requests through Result and Effect", async () => {
    const invalidId = defaultApi.assets.avatar({ id: "01", avatar: "avatar_hash" })
    expect(invalidId.isErr()).toBe(true)
    if (invalidId.isErr())
        expect(invalidId.error).toMatchObject({
            _tag: "AssetUrlError",
            operation: "assets.avatar",
            reason: "id",
        })

    expect(defaultApi.assets.avatar({ id: userId, avatar: "bad-hash" }).isErr()).toBe(true)
    expect(defaultApi.assets.avatar({ id: userId, avatar: "a_" }).isErr()).toBe(true)
    const arbitraryOrigin = { origin: "https://untrusted.example" }
    // @ts-expect-error Asset URL helpers have no caller-provided origin option.
    const arbitraryOriginResult = defaultApi.assets.avatar({ id: userId, avatar: "avatar_hash" }, arbitraryOrigin)
    expect(arbitraryOriginResult.isErr()).toBe(true)
    expect(defaultApi.assets.displayAvatar({ id: userId, avatar: null }, { size: -1 }).isErr()).toBe(true)
    expect(
        defaultApi.assets.guildIcon({ id: guildId }, { format: defaultApi.AssetFormats.Png, animated: true }).isErr(),
    ).toBe(true)
    expect(
        value(
            defaultApi.assets.avatar(
                { id: userId, avatar: "a_animated" },
                { format: defaultApi.AssetFormats.Png, animated: false },
            ),
        ),
    ).toBe(`https://fluxerusercontent.com/avatars/${userId}/a_animated.png?animated=false`)
    expect(
        defaultApi.assets.avatar({ id: userId, avatar: "a_animated" }, { format: defaultApi.AssetFormats.Png }).isErr(),
    ).toBe(true)
    expect(defaultApi.assets.avatar({ id: userId, avatar: "avatar_hash" }, { size: 4_294_967_296 }).isErr()).toBe(true)
    expect(
        defaultApi.assets.emoji({ id: expressionId, animated: true }, { format: defaultApi.AssetFormats.Jpeg }).isErr(),
    ).toBe(true)
    expect(
        defaultApi.assets
            .sticker({ id: expressionId, animated: false }, { format: defaultApi.AssetFormats.Webp } as never)
            .isErr(),
    ).toBe(true)
    expect(
        defaultApi.assets
            .displayMemberAvatar(
                { id: userId, avatar: null },
                { guildId, userId: memberId, avatar: null, profileFlags: 0 },
            )
            .isErr(),
    ).toBe(true)
    const memberFallbackError = defaultApi.assets.displayMemberAvatar(
        { id: userId, avatar: "a_animated" },
        { guildId, userId, avatar: null, profileFlags: 0 },
        { format: defaultApi.AssetFormats.Png },
    )
    expect(memberFallbackError.isErr()).toBe(true)
    if (memberFallbackError.isErr())
        expect(memberFallbackError.error).toMatchObject({
            _tag: "AssetUrlError",
            operation: "assets.displayMemberAvatar",
            reason: "options",
        })

    await expect(nativeError(native.assets.avatar({ id: "01", avatar: "avatar_hash" }))).resolves.toMatchObject({
        _tag: "AssetUrlError",
        operation: "assets.avatar",
        reason: "id",
    })
    await expect(
        nativeError(native.assets.emoji({ id: expressionId, animated: true }, { format: native.AssetFormats.Png })),
    ).resolves.toMatchObject({
        _tag: "AssetUrlError",
        operation: "assets.emoji",
        reason: "options",
    })
    await expect(
        nativeError(
            native.assets.displayAvatar({ id: userId, avatar: null }, { origin: "https://untrusted.example" } as never),
        ),
    ).resolves.toMatchObject({
        _tag: "AssetUrlError",
        operation: "assets.displayAvatar",
        reason: "options",
    })
})

test("defers native asset inspection until Effect execution", async () => {
    const user: { id: string; avatar: string | null } = { id: userId, avatar: null }
    const displayAvatar = native.assets.displayAvatar(user)
    user.avatar = "changed_hash"

    expect(await Effect.runPromise(displayAvatar)).toBe(
        `https://fluxerusercontent.com/avatars/${userId}/changed_hash.webp`,
    )
})
