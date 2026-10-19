// Scrubbing of live gateway payloads into committable fixtures. Strings, numbers and field names are default-deny:
// - Every string becomes a stable synthetic placeholder of the same kind, apart from the protocol vocabulary in
//   `vocabulary`, which passes only when the key and the exact value are both listed
// - A number passes only under a key in `numberKeys` (protocol enums, flags, positions, colors and counts that were
//   reviewed), a clock value is replaced by a distinct synthetic one, any other number is replaced, and a number of
//   1e11 or more outside a clock key is refused
// - Flags pass only on the top-level object (the message), its referenced message and objects with the bot's own ID,
//   and are 0 anywhere else, such as on a nested user or member
// - A field name must be in `knownKeys`. An unfamiliar or identifier-like name is refused until it is reviewed and added
// After scrubbing, `assertScrubbed` refuses a result that still contains a listed secret, or any captured string of
// four or more characters (digit-only strings under eight digits excepted, because a placeholder can equal them), so
// a rule that misses a string fails the capture instead of leaking it. Nothing here reads credentials from the
// environment or writes files

/** Thrown when a scrubbed result still holds a sensitive value. The message never contains the value */
export class ScrubRefusal extends Error {
    constructor(reason) {
        super(reason)
        this.name = "ScrubRefusal"
    }
}

/** Protocol vocabulary that carries no sandbox data, by the key that holds it */
export const vocabulary = Object.freeze({
    // Embed kinds
    type: new Set(["rich", "image", "video", "gifv", "article", "link", "audio"]),
})

/** Field names seen in reviewed captures. A capture holding any other name is refused until the name is reviewed */
export const knownKeys = new Set(
    (
        "accent_color attachments author author_id avatar avatar_color banner bot channel_id channel_type color " +
        "communication_disabled_until content content_warning_level content_warning_text deaf description " +
        "discriminator edited_timestamp embeds emoji fields flags footer global_name guild_id id inline joined_at " +
        "last_message_id last_pin_timestamp member mention_everyone mention_roles mentions message_id " +
        "message_reference mute name nick nsfw nsfw_override parent_id permission_overwrites pinned position " +
        "rate_limit_per_user referenced_message roles stickers text timestamp title topic tts type url user user_id " +
        "username value"
    ).split(" "),
)

/** Numbers that pass unchanged, by key: Protocol enums, flag fields, positions, colors and counts */
export const numberKeys = new Set([
    "channel_type",
    "color",
    "content_warning_level",
    "flags",
    "position",
    "rate_limit_per_user",
    "type",
])

const snowflake = /^[0-9]{16,20}$/
const digits = /^[0-9]+$/
const timestamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const address = /^[a-z][a-z0-9+.-]*:\/\//i
const hashKey = /(^|_)(avatar|banner|icon|splash|hash)$/
const hexadecimal = /^(a_)?[0-9a-f]{8,}$/
/** Keys that hold a time, including millisecond forms such as `last_timestamp_ms` */
export const clockKey = /(^|_)(timestamp|at|until)(_ms)?$/
const epoch = Date.UTC(2026, 0, 1)

/** Whether the `flags` of an object may pass: The payload itself, its referenced message or the bot's own object */
const keepsFlagsAt = (botId) => (value, path) =>
    path === "the payload" || path === "the payload.referenced_message" || (botId !== undefined && value.id === botId)

/** A scrubber with its own stable maps, so one placeholder always stands for the same original value */
export function createScrubber({ botId } = {}) {
    const keepsFlags = keepsFlagsAt(botId)
    const originals = new Set()
    const maps = new Map()
    const kept = new Set()
    const number = (kind, value) => {
        const map = maps.get(kind) ?? new Map()
        maps.set(kind, map)
        if (!map.has(value)) map.set(value, map.size + 1)
        return map.get(value)
    }
    const text = (key, value) => {
        if (vocabulary[key]?.has(value)) {
            kept.add(value)
            return value
        }
        originals.add(value)
        if (value === "") return ""
        if (snowflake.test(value)) return String(1_000_000_000_000_000_000n + BigInt(number("id", value)))
        if (digits.test(value)) {
            // Nothing to hide in zeros, and a placeholder equal to its original would only look like a leak
            if (/^0+$/.test(value)) {
                originals.delete(value)
                return value
            }
            return String(number("digits", value)).padStart(value.length, "0")
        }
        const stamp = timestamp.exec(value)
        if (stamp) {
            const iso = new Date(epoch + number("timestamp", value) * 1000).toISOString()
            return `${iso.slice(0, 19)}${stamp[3] ? `.${"0".repeat(stamp[3].length - 1)}` : ""}${stamp[4] === "Z" ? "Z" : "+00:00"}`
        }
        if (address.test(value)) return `https://example.invalid/${key}/${number("address", value)}`
        if (hashKey.test(key) || hexadecimal.test(value)) {
            const prefix = value.startsWith("a_") ? "a_" : ""
            const body = number("hash", value)
                .toString(16)
                .padStart(Math.max(8, value.length - prefix.length), "0")
            return `${prefix}${body}`
        }
        return `${key}-${number(key, value)}`
    }
    const walk = (value, key, path) => {
        if (typeof value === "string") return text(key, value)
        if (typeof value === "number") {
            if (clockKey.test(key))
                return value >= 1e11
                    ? 1_767_225_600_000 + number("clock-ms", value)
                    : 1_767_225_600 + number("clock-seconds", value)
            if (Math.abs(value) >= 1e11) throw new ScrubRefusal(`A large number outside a time field below ${path}`)
            return numberKeys.has(key) ? value : number(`number-${key}`, value)
        }
        if (Array.isArray(value)) return value.map((item) => walk(item, key, `${path}[]`))
        if (value !== null && typeof value === "object")
            return Object.fromEntries(
                Object.entries(value).map(([name, item]) => {
                    // Flags of an account can identify a person, so they stay only on the message itself, its referenced
                    // message and objects of the bot's own account
                    if (name === "flags" && typeof item === "number" && !keepsFlags(value, path)) return [name, 0]
                    if (!knownKeys.has(name))
                        throw new ScrubRefusal(
                            `Unreviewed field name ${/^[a-z]+(_[a-z]+)*$/.test(name) && name.length <= 32 ? `"${name}" ` : ""}below ${path}`,
                        )
                    return [name, walk(item, name, `${path}.${name}`)]
                }),
            )
        return value
    }
    return {
        scrub: (value) => walk(value, "value", "the payload"),
        /** Original strings the scrubber saw, apart from the listed protocol vocabulary */
        originals,
        kept,
    }
}

/**
 * Refuses a scrubbed result that still holds a secret or an original string. `secrets` are values that must not
 * occur anywhere in the serialized result, such as the token and the server, bot and channel IDs, and the names of
 * accounts. The scrubber's own originals must not survive as a value or a key either
 */
export function assertScrubbed(scrubbed, { secrets, originals, kept = new Set() }) {
    const text = JSON.stringify(scrubbed)
    for (const secret of secrets) {
        if (typeof secret !== "string" || secret === "") continue
        if (text.includes(JSON.stringify(secret).slice(1, -1))) throw new ScrubRefusal("A sensitive value survived")
    }
    const survivors = new Set()
    const collect = (value) => {
        if (typeof value === "string") survivors.add(value)
        else if (Array.isArray(value)) value.forEach(collect)
        else if (value !== null && typeof value === "object")
            for (const [name, item] of Object.entries(value)) {
                survivors.add(name)
                collect(item)
            }
    }
    collect(scrubbed)
    for (const original of originals) {
        if (original === "" || kept.has(original)) continue
        // A long original must not occur even inside another string. Short ones can equal a field name or a
        // placeholder by coincidence, so only an exact match of four or more characters counts
        if (original.length >= 8 && text.includes(JSON.stringify(original).slice(1, -1)))
            throw new ScrubRefusal("An original string survived")
        if (original.length >= 4 && !(digits.test(original) && original.length < 8) && survivors.has(original))
            throw new ScrubRefusal("An original string survived")
    }
}
