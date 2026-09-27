import { afterEach, expect, test, vi } from "vitest"
import { assets, AssetUrlError, type UserProfile } from "../../../src/index.js"
import { assets as nativeAssets } from "../../../src/effect.js"

afterEach(() => vi.unstubAllGlobals())

const entries = [
    ["default", assets],
    ["effect", nativeAssets],
] as const

function thrown(run: () => unknown): AssetUrlError {
    try {
        run()
    } catch (error) {
        expect(error).toBeInstanceOf(AssetUrlError)
        return error as AssetUrlError
    }
    throw new Error("Expected the asset helper to throw AssetUrlError")
}

for (const [mode, api] of entries) {
    test(`${mode}: account banner accepts a profile observation without a lookup`, () => {
        const fetch = vi.fn(() => {
            throw new Error("Unexpected asset request")
        })
        vi.stubGlobal("fetch", fetch)
        const profile = { user: { id: "1750000000000000000" }, profile: { banner: "account_banner" } }
        expect(api.userBanner(profile, { size: 512 })).toBe(
            "https://fluxerusercontent.com/banners/1750000000000000000/account_banner.webp?size=512",
        )
        expect(fetch).not.toHaveBeenCalled()
    })

    test(`${mode}: null account banner preserves absent or withheld profile data`, () => {
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
        expect(api.userBanner(profile)).toBeNull()
        expect(thrown(() => api.userBanner(profile, { size: -1 }))).toMatchObject({ reason: "options" })
    })

    test(`${mode}: account banner rejects malformed structural targets, hashes and transforms`, () => {
        for (const profile of [
            null,
            {},
            { user: {} },
            { user: { id: "bad" }, profile: { banner: "hash" } },
            { user: { id: "20" }, profile: {} },
            { user: { id: "20" }, profile: { banner: "../private" } },
        ]) {
            const error = thrown(() => api.userBanner(profile as unknown as Parameters<typeof api.userBanner>[0]))
            expect(error).toMatchObject({ _tag: "AssetUrlError", operation: "assets.userBanner" })
            expect(JSON.stringify(error)).not.toContain("private")
        }
        const profile = { user: { id: "20" }, profile: { banner: "a_banner" } }
        expect(thrown(() => api.userBanner(profile, { animated: true, format: "png" }))).toMatchObject({
            reason: "options",
            // The message names the accepted options instead of only the helper
            message: expect.stringContaining("size"),
        })
    })

    test(`${mode}: banner construction reads the profile when called`, () => {
        const profile = { user: { id: "20" }, profile: { banner: "first" } }
        const first = api.userBanner(profile)
        profile.profile.banner = "second"
        expect(first).toBe("https://fluxerusercontent.com/banners/20/first.webp")
        expect(api.userBanner(profile)).toBe("https://fluxerusercontent.com/banners/20/second.webp")
    })
}
