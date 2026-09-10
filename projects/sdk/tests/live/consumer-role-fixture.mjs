import assert from "node:assert/strict"

const ids = (value) => {
    assert.ok(Array.isArray(value) && value.every((id) => typeof id === "string" && /^[1-9][0-9]*$/.test(id)))
    assert.equal(new Set(value).size, value.length)
    return [...value].sort()
}
const same = (actual, expected) => JSON.stringify(ids(actual)) === JSON.stringify(ids(expected))

/** Restore only the journaled bot's baseline plus one unchanged, zero-permission test role */
export async function restoreConsumerBotRoles(api, journal, guildId, botId) {
    assert.equal(journal.kind, "consumer-operations")
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    if (journal.baselineRoleIds === undefined) {
        assert.equal(journal.roleName, undefined)
        assert.equal(journal.roleId, undefined)
        return
    }
    const baseline = ids(journal.baselineRoleIds)
    const path = `/guilds/${guildId}/members/${botId}`
    const read = async () => {
        const response = await api("GET", path)
        assert.equal(response.status, 200)
        assert.equal(response.data?.user?.id, botId)
        return ids(response.data?.roles)
    }
    const current = await read()
    if (same(current, baseline)) return
    assert.match(journal.roleId ?? "", /^[1-9][0-9]*$/)
    assert.match(journal.roleName ?? "", /^fluxerly-sdk-role-[a-f0-9]{32}$/)
    const roles = await api("GET", `/guilds/${guildId}/roles`)
    assert.equal(roles.status, 200)
    assert.ok(Array.isArray(roles.data))
    const matches = roles.data.filter((role) => role.name === journal.roleName)
    assert.equal(matches.length, 1)
    assert.equal(matches[0].id, journal.roleId)
    assert.equal(String(matches[0].permissions), "0")
    const expected = ids([...baseline, journal.roleId])
    assert.ok(same(current, expected), "Conflicting bot-role change; retain recovery journal")
    // A fresh read detects conflicts during role verification, but Fluxer has no atomic compare-and-set PATCH
    assert.ok(same(await read(), expected), "Conflicting bot-role change; retain recovery journal")
    const restored = await api("PATCH", path, { roles: baseline })
    assert.equal(restored.status, 200)
    assert.equal(restored.data?.user?.id, botId)
    assert.ok(same(restored.data?.roles, baseline))
    assert.ok(same(await read(), baseline))
}
