import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

/** Record intent before creation; a lost response is reconciled by one unique marker, not another POST */
export async function createGuildTestRole(api, journal, save, create) {
    assert.equal(journal.roleName, undefined)
    journal.roleName = `fluxerly-sdk-role-${randomUUID().replaceAll("-", "")}`
    save()
    const created = create
        ? { data: await create({ name: journal.roleName }) }
        : await api("POST", `/guilds/${journal.guildId}/roles`, {
              name: journal.roleName,
              permissions: "0",
              color: 0,
          })
    assert.match(created.data?.id ?? "", /^\d+$/)
    journal.roleId = created.data.id
    save()
    assert.equal(created.data.name, journal.roleName)
    assert.equal(String(created.data.permissions), "0")
    return journal.roleId
}

/** Delete only the journaled zero-permission test role; preserve an unresolved journal or externally changed role */
export async function cleanupGuildTestRole(api, journal, save) {
    if (journal.secondRole) {
        assert.equal(journal.secondRole.guildId, journal.guildId)
        assert.equal(journal.secondRole.secondRole, undefined)
        await cleanupGuildTestRole(api, journal.secondRole, save)
    }
    if (journal.roleName === undefined) return
    assert.match(journal.roleName, /^fluxerly-sdk-role-[a-f0-9]{32}$/)
    const path = `/guilds/${journal.guildId}/roles`
    const listed = await api("GET", path)
    assert.ok(Array.isArray(listed.data))
    const matches = listed.data.filter((role) => role.name === journal.roleName)
    assert.ok(matches.length <= 1)
    if (matches.length === 0) assert.match(journal.roleId ?? "", /^\d+$/)
    for (const role of matches) {
        assert.match(role.id, /^\d+$/)
        assert.equal(role.permissions, "0")
        if (journal.roleId !== undefined) assert.equal(role.id, journal.roleId)
        journal.roleId = role.id
        await save()
        assert.equal((await api("DELETE", `${path}/${role.id}`)).status, 204)
    }
    const after = await api("GET", path)
    assert.ok(
        Array.isArray(after.data) &&
            !after.data.some((role) => role.id === journal.roleId || role.name === journal.roleName),
    )
}
