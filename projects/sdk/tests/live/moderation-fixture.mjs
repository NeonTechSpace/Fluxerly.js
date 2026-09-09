import assert from "node:assert/strict"

// Recovery removes only the timeout/ban recorded before this test's requests
export async function cleanupModeration(api, journal, authorizedUserId) {
    const fixture = journal.moderation
    if (!fixture) return
    assert.equal(fixture.userId, authorizedUserId)
    assert.match(fixture.userId, /^[1-9][0-9]*$/)
    assert.equal(fixture.reason, `${journal.name}-moderation`)
    const self = await api("GET", "/users/@me")
    assert.equal(self.status, 200)
    assert.equal(self.data?.id, fixture.botId)
    assert.notEqual(fixture.userId, fixture.botId)
    const guild = await api("GET", `/guilds/${journal.guildId}`)
    assert.equal(guild.status, 200)
    assert.equal(guild.data?.id, journal.guildId)
    assert.notEqual(guild.data?.owner_id, fixture.userId)
    const bans = await api("GET", `/guilds/${journal.guildId}/bans`)
    assert.equal(bans.status, 200)
    assert.ok(Array.isArray(bans.data))
    const ban = bans.data.find((item) => item.user?.id === fixture.userId)
    if (ban) {
        assert.equal(ban.reason, fixture.reason)
        assert.equal(ban.moderator_id, fixture.botId)
        await api("DELETE", `/guilds/${journal.guildId}/bans/${fixture.userId}`)
    }
    const after = await api("GET", `/guilds/${journal.guildId}/bans`)
    assert.equal(after.status, 200)
    assert.ok(Array.isArray(after.data) && !after.data.some((item) => item.user?.id === fixture.userId))
    const member = await api("GET", `/guilds/${journal.guildId}/members/${fixture.userId}`)
    assert.ok(member.status === 200 || member.status === 404)
    if (member.status === 200) {
        assert.equal(member.data?.user?.id, fixture.userId)
        const until = member.data.communication_disabled_until
        if (until !== null && until !== undefined) {
            assert.ok(fixture.timeoutUntil && Date.parse(until) === Date.parse(fixture.timeoutUntil))
            await api("PATCH", `/guilds/${journal.guildId}/members/${fixture.userId}`, {
                communication_disabled_until: null,
            })
            const restored = await api("GET", `/guilds/${journal.guildId}/members/${fixture.userId}`)
            assert.equal(restored.status, 200)
            assert.equal(restored.data?.communication_disabled_until ?? null, null)
        }
    }
}
