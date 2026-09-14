import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

export const reactionEmojiImage =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQSPjwHwAEhAJwb6BLPQAAAABJRU5ErkJggg=="

/** Journal intent before creation; never retry an ambiguous create under a new name */
export async function createReactionEmoji(api, journal, save, botId) {
    assert.equal(journal.emojiName, undefined)
    journal.emojiName = `fluxerly_${randomUUID().replaceAll("-", "").slice(0, 23)}`
    journal.emojiOwnerId = botId
    save()
    let created
    try {
        created = await api("POST", `/guilds/${journal.guildId}/emojis`, {
            name: journal.emojiName,
            image: reactionEmojiImage,
        })
    } catch (error) {
        // Fluxer rejects invalid form input before storing an emoji; transport failures remain ambiguous
        if (error?.status === 400 && error?.code === "INVALID_FORM_BODY") {
            journal.emojiCreateRejected = true
            save()
        }
        throw error
    }
    assert.match(created.data?.id ?? "", /^\d+$/)
    journal.emojiId = created.data.id
    save()
    assert.equal(created.data.name, journal.emojiName)
    const listed = await api("GET", `/guilds/${journal.guildId}/emojis`)
    assert.ok(Array.isArray(listed.data))
    const matches = listed.data.filter((item) => item.id === journal.emojiId && item.name === journal.emojiName)
    assert.equal(matches.length, 1)
    assert.equal(matches[0].user?.id, botId)
    return { name: journal.emojiName, id: journal.emojiId }
}

/** Resolve only the journal's unique marker and uploader; retain unresolved intent rather than guessing absence */
export async function cleanupReactionEmoji(api, journal, save) {
    if (journal.emojiName === undefined) return
    assert.match(journal.guildId ?? "", /^\d+$/)
    // Accept the previous 33-character marker only to recover journals written before the length fix
    assert.match(journal.emojiName, /^fluxerly_[a-f0-9]{23,24}$/)
    assert.match(journal.emojiOwnerId ?? "", /^\d+$/)
    const path = `/guilds/${journal.guildId}/emojis`
    const listed = await api("GET", path)
    assert.ok(Array.isArray(listed.data))
    const matches = listed.data.filter((item) => item.name === journal.emojiName)
    assert.ok(matches.length <= 1)
    if (matches.length === 0 && journal.emojiCreateRejected !== true) assert.match(journal.emojiId ?? "", /^\d+$/)
    for (const item of matches) {
        assert.match(item.id, /^\d+$/)
        assert.equal(item.user?.id, journal.emojiOwnerId)
        if (journal.emojiId !== undefined) assert.equal(item.id, journal.emojiId)
        journal.emojiId = item.id
        await save()
        await api("DELETE", `${path}/${item.id}`)
    }
    const after = await api("GET", path)
    assert.ok(
        Array.isArray(after.data) &&
            !after.data.some((item) => item.name === journal.emojiName || item.id === journal.emojiId),
    )
}
