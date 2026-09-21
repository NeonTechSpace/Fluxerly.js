import { expect, test } from "vitest"
import { decodeGuildEvent } from "../src/internal/guilds.js"

test("a provider-driven member profile change remains a complete new member observation", () => {
    const projected = decodeGuildEvent("GUILD_MEMBER_UPDATE", {
        guild_id: "20",
        user: { id: "30", username: "renamed_account", bot: false },
        roles: ["40"],
        joined_at: "2026-09-21T00:00:00.000Z",
        nick: "new guild profile",
        avatar: "member-avatar",
        banner: null,
        accent_color: 0,
        mute: false,
        deaf: false,
        communication_disabled_until: null,
        profile_flags: 1,
        mention_flags: 2,
    })

    expect(projected).toEqual({
        guildId: "20",
        userId: "30",
        username: "renamed_account",
        isBot: false,
        roleIds: ["40"],
        joinedAt: "2026-09-21T00:00:00.000Z",
        communicationDisabledUntil: null,
        nickname: "new guild profile",
        avatar: "member-avatar",
        banner: null,
        accentColor: 0,
        isMuted: false,
        isDeafened: false,
        profileFlags: 1,
        mentionFlags: 2,
    })
    if (!projected || !("roleIds" in projected)) throw new Error("Expected a projected guild member")
    expect(Object.isFrozen(projected) && Object.isFrozen(projected.roleIds)).toBe(true)
})
