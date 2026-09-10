import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { assets, AssetUrlError, type UserProfile } from "../src/index.js"
import { assets as nativeAssets } from "../src/effect.js"

afterEach(() => vi.unstubAllGlobals())

test("account banner accepts a profile observation without a lookup", async () => {
    const fetch = vi.fn(() => {
        throw new Error("Unexpected asset request")
    })
    vi.stubGlobal("fetch", fetch)
    const profile = { user: { id: "1750000000000000000" }, profile: { banner: "account_banner" } }
    const expected = "https://fluxerusercontent.com/banners/1750000000000000000/account_banner.webp?size=512"
    expect(assets.userBanner(profile, { size: 512 })._unsafeUnwrap()).toBe(expected)
    expect(await Effect.runPromise(nativeAssets.userBanner(profile, { size: 512 }))).toBe(expected)
    expect(fetch).not.toHaveBeenCalled()
})

test("null account banner preserves absent or withheld profile data", async () => {
    const profile: UserProfile = {
        user: {
            id: "1750000000000000000",
            username: "fixture",
            discriminator: "0001",
            displayName: null,
            avatar: null,
            avatarColor: null,
            isBot: true,
            isSystem: false,
            flags: 0,
        },
        profile: { bio: null, pronouns: null, banner: null, accentColor: null },
        guildProfile: null,
        isLimited: true,
    }
    expect(assets.userBanner(profile)._unsafeUnwrap()).toBeNull()
    expect(await Effect.runPromise(nativeAssets.userBanner(profile))).toBeNull()
    expect(assets.userBanner(profile, { size: -1 })._unsafeUnwrapErr()).toMatchObject({ reason: "options" })
})

test("account banner rejects malformed structural targets, hashes and transforms in both entries", async () => {
    for (const profile of [
        null,
        {},
        { user: {} },
        { user: { id: "bad" }, profile: { banner: "hash" } },
        { user: { id: "20" }, profile: {} },
        { user: { id: "20" }, profile: { banner: "../private" } },
    ]) {
        const input = profile as unknown as Parameters<typeof assets.userBanner>[0]
        const error = assets.userBanner(input)._unsafeUnwrapErr()
        expect(error).toBeInstanceOf(AssetUrlError)
        expect(error.operation).toBe("assets.userBanner")
        expect(await Effect.runPromise(Effect.flip(nativeAssets.userBanner(input)))).toMatchObject({
            _tag: "AssetUrlError",
            operation: "assets.userBanner",
        })
        expect(JSON.stringify(error)).not.toContain("private")
    }
    const profile = { user: { id: "20" }, profile: { banner: "a_banner" } }
    expect(assets.userBanner(profile, { animated: true, format: "png" })._unsafeUnwrapErr()).toMatchObject({
        reason: "options",
    })
    expect(
        await Effect.runPromise(Effect.flip(nativeAssets.userBanner(profile, { animated: true, format: "png" }))),
    ).toMatchObject({ reason: "options" })
})

test("default banner construction is immediate and native construction is lazy", async () => {
    const profile = { user: { id: "20" }, profile: { banner: "first" } }
    const defaultApi = assets.userBanner(profile)
    const native = nativeAssets.userBanner(profile)
    profile.profile.banner = "second"
    expect(defaultApi._unsafeUnwrap()).toBe("https://fluxerusercontent.com/banners/20/first.webp")
    expect(await Effect.runPromise(native)).toBe("https://fluxerusercontent.com/banners/20/second.webp")
})
