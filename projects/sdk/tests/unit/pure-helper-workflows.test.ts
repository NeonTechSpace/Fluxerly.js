import { afterEach, expect, test, vi } from "vitest"
import * as defaultApi from "../../src/index.js"
import * as native from "../../src/effect.js"

afterEach(() => vi.unstubAllGlobals())

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Whether an index of the text falls between two visible characters */
const isGraphemeBoundary = (content: string, index: number): boolean =>
    index >= content.length || graphemes.segment(content).containing(index)!.index === index

/** Return the HelperError a plain helper throws for invalid input. Returning normally fails the test */
function thrown(run: () => unknown): unknown {
    try {
        run()
    } catch (error) {
        expect(error).toBeInstanceOf(defaultApi.HelperError)
        return error
    }
    throw Error("Expected the helper to throw HelperError")
}

test("composes and inspects raw permission sets without discarding unknown bits or expanding Administrator", () => {
    vi.stubGlobal("fetch", () => {
        throw Error("Pure helpers must not fetch")
    })
    const bits = defaultApi.permissionBits.from(["ManageMessages", "ManageRoles", "ManageMessages"])
    expect(bits).toBe(defaultApi.Permissions.ManageMessages | defaultApi.Permissions.ManageRoles)
    expect(defaultApi.permissionBits.from([])).toBe(0n)
    expect(defaultApi.permissionBits.hasAll(bits, ["ManageRoles", "ManageMessages"])).toBe(true)
    expect(defaultApi.permissionBits.hasAll(bits, ["BanMembers", "ManageMessages"])).toBe(false)
    expect(defaultApi.permissionBits.hasAny(bits, ["BanMembers", "ManageMessages"])).toBe(true)
    expect(defaultApi.permissionBits.hasAny(bits, ["BanMembers"])).toBe(false)
    expect(defaultApi.permissionBits.hasAll(bits, [])).toBe(true)
    expect(defaultApi.permissionBits.hasAny(bits, [])).toBe(false)
    expect(defaultApi.permissionBits.hasAll(defaultApi.Permissions.Administrator, ["ManageRoles"])).toBe(false)
    const missing = defaultApi.permissionBits.missing(bits, ["BanMembers", "KickMembers", "BanMembers", "ManageRoles"])
    expect(missing).toEqual(["BanMembers", "KickMembers"])
    expect(Object.isFrozen(missing)).toBe(true)
    const unknown = 1n << 63n
    const inspection = defaultApi.permissionBits.inspect(bits | unknown)
    expect(inspection).toEqual({ names: ["ManageMessages", "ManageRoles"], unknownBits: unknown })
    expect(defaultApi.permissionBits.from(inspection.names) | inspection.unknownBits).toBe(bits | unknown)
    expect(Object.isFrozen(inspection)).toBe(true)
    expect(Object.isFrozen(inspection.names)).toBe(true)
})

// Fluxer 4749eb7f ThreadPermissionFlags: Inspection once reported these bits as unknown and names rejected them
test("names the thread permission bits", () => {
    const threadBits = (1n << 34n) | (1n << 35n) | (1n << 36n) | (1n << 38n)
    const names = ["ManageThreads", "CreatePublicThreads", "CreatePrivateThreads", "SendMessagesInThreads"] as const
    expect(defaultApi.permissionBits.from(names)).toBe(threadBits)
    expect(defaultApi.permissionBits.inspect(threadBits)).toEqual({ names, unknownBits: 0n })
    expect(defaultApi.guards.requirePermissions(["SendMessagesInThreads"])).toBeTypeOf("function")
    expect(native.guards.requirePermissions(["SendMessagesInThreads"])).toBeTypeOf("function")
})

test("validates every permission name and unsigned-64-bit input without leaking rejected values", () => {
    for (const names of [["ManageRoles", "secret-invalid-name"], ["toString"], Array(1), null]) {
        for (const operation of [
            () => defaultApi.permissionBits.from(names as never),
            () => defaultApi.permissionBits.hasAll(0n, names as never),
            () => defaultApi.permissionBits.hasAny(defaultApi.Permissions.ManageRoles, names as never),
            () => defaultApi.permissionBits.missing(0n, names as never),
        ]) {
            const error = thrown(operation)
            expect(error).toMatchObject({ _tag: "HelperError", reason: "permissionBits" })
            expect(JSON.stringify(error)).not.toContain("secret-invalid-name")
        }
    }
    for (const bits of [-1n, 1n << 64n, 1, "1", null]) {
        for (const operation of [
            () => defaultApi.permissionBits.hasAll(bits as never, []),
            () => defaultApi.permissionBits.hasAny(bits as never, []),
            () => defaultApi.permissionBits.missing(bits as never, []),
            () => defaultApi.permissionBits.inspect(bits as never),
        ])
            expect(thrown(operation)).toMatchObject({ _tag: "HelperError", reason: "permissionBits" })
    }
})

test("converts color configuration in both directions and rejects coercion or lossy inputs", () => {
    vi.stubGlobal("fetch", () => {
        throw Error("Pure helpers must not fetch")
    })
    for (const input of ["#ff8800", "FF8800", 0xff8800, [255, 136, 0]] as const)
        expect(defaultApi.colors.parse(input)).toBe(0xff8800)
    expect(defaultApi.colors.toHex(1)).toBe("#000001")
    expect(defaultApi.colors.toHex(0xffffff)).toBe("#ffffff")
    const rgb = defaultApi.colors.toRgb(0xff8800)
    expect(rgb).toEqual([255, 136, 0])
    expect(Object.isFrozen(rgb)).toBe(true)
    expect(defaultApi.colors.parse(rgb)).toBe(0xff8800)
    const alternating: [number, number, number] = [0, 0, 0]
    let greenReads = 0
    Object.defineProperty(alternating, 1, {
        get: () => (greenReads++ === 0 ? 1 : 999),
        enumerable: true,
    })
    expect(defaultApi.colors.parse(alternating)).toBe(0x000100)
    expect(greenReads).toBe(1)
    const iteratorMasked = [0, 999, 0]
    Object.defineProperty(iteratorMasked, Symbol.iterator, {
        value: function* () {
            yield 0
            yield 0
            yield 0
        },
    })
    expect(thrown(() => defaultApi.colors.parse(iteratorMasked as never))).toMatchObject({
        operation: "colors.parse",
        reason: "color",
    })
    for (const input of [
        "red",
        "#fff",
        "#ffffff00",
        " #ff8800",
        -1,
        0x1000000,
        1.5,
        NaN,
        Infinity,
        [255, 0],
        [255, 0, 0, 0],
        [255, "0", 0],
        [256, 0, 0],
        Array(3),
        null,
    ])
        expect(thrown(() => defaultApi.colors.parse(input as never))).toMatchObject({
            operation: "colors.parse",
            reason: "color",
        })
    for (const input of [-1, 0x1000000, 1.5, NaN, "1"])
        for (const operation of [
            () => defaultApi.colors.toHex(input as never),
            () => defaultApi.colors.toRgb(input as never),
        ])
            expect(thrown(operation)).toMatchObject({ reason: "color" })
})

test("splits losslessly at line, word and surrogate-safe hard boundaries", () => {
    vi.stubGlobal("fetch", () => {
        throw Error("Pure helpers must not fetch")
    })
    expect(defaultApi.text.split("", { maxLength: 3 })).toEqual([])
    expect(defaultApi.text.split("ab\ncd ef", { maxLength: 7 })).toEqual(["ab\n", "cd ef"])
    expect(defaultApi.text.split("one two three", { maxLength: 8 })).toEqual(["one two ", "three"])
    expect(defaultApi.text.split("abcd", { maxLength: 2 })).toEqual(["ab", "cd"])
    const content = "A🦊e\u0301\r\n👨‍👩‍👧‍👦 `code` @everyone\t"
    for (let maxLength = 2; maxLength < 15; maxLength++) {
        const parts = defaultApi.text.split(content, { maxLength })
        expect(parts.join("")).toBe(content)
        expect(parts.every((piece) => piece.length > 0 && piece.length <= maxLength && piece.isWellFormed())).toBe(true)
        expect(Object.isFrozen(parts)).toBe(true)
    }
    expect(thrown(() => defaultApi.text.split("🦊", { maxLength: 1 }))).toMatchObject({ reason: "limit" })
    expect(thrown(() => defaultApi.text.split(1 as never, { maxLength: 2 }))).toMatchObject({ reason: "text" })
    for (const options of [
        undefined,
        null,
        [],
        { maxLength: 0 },
        { maxLength: -1 },
        { maxLength: 1.5 },
        { maxLength: "2" },
        { maxLength: Infinity },
        { maxLength: 2, unknown: true },
    ])
        expect(thrown(() => defaultApi.text.split("private-text", options as never))).toMatchObject({
            operation: "text.split",
            reason: "limit",
        })
    expect(thrown(() => defaultApi.text.split(1 as never, { maxLength: 2 }))).toMatchObject({ reason: "text" })
})

test("splits between visible characters and still joins back to the input", () => {
    const split = (content: string, maxLength: number) => defaultApi.text.split(content, { maxLength })
    // A flag, a skin tone, a joined emoji and a combining mark are never separated
    expect(split("aaaaaaaaa🇩🇪", 11)).toEqual(["aaaaaaaaa", "🇩🇪"])
    expect(split("ab👍🏽c", 5)).toEqual(["ab", "👍🏽c"])
    expect(split("ab👨‍👩‍👧‍👦c", 11)).toEqual(["ab", "👨‍👩‍👧‍👦", "c"])
    expect(split("abcde\u0301f", 5)).toEqual(["abcd", "e\u0301f"])
    // A carriage return and the line feed after it are one character, and a space before a combining mark is not a boundary
    expect(split("ab\r\ncd", 3)).toEqual(["ab", "\r\n", "cd"])
    expect(split("one\r\ntwo", 4)).toEqual(["one", "\r\n", "two"])
    expect(split("one \u0301two three", 5)).toEqual(["one \u0301", "two ", "three"])
    // A first character longer than the limit is cut between code points, which still advances
    const long = "e" + "\u0301".repeat(7)
    expect(split(long, 3)).toEqual([long.slice(0, 3), long.slice(3, 6), long.slice(6)])
    expect(split("ab" + long + "cd", 4)).toEqual(["ab", long.slice(0, 4), long.slice(4), "cd"])
    for (const content of [
        "aaaaaaaaa🇩🇪 \u0301x\r\n",
        "A🦊e\u0301\r\n👨‍👩‍👧‍👦 `code` @everyone\t",
        "one \u0301two\r\nthree 👍🏽 four " + long,
    ])
        for (let maxLength = 2; maxLength < 16; maxLength++) {
            const parts = split(content, maxLength)
            expect(parts.join("")).toBe(content)
            expect(parts.every((piece) => piece.length > 0 && piece.length <= maxLength && piece.isWellFormed())).toBe(
                true,
            )
        }
})

test("truncates to the limit with a suffix, keeping surrogate pairs whole", () => {
    vi.stubGlobal("fetch", () => {
        throw Error("Pure helpers must not fetch")
    })
    // Text that fits is returned unchanged, even when it ends exactly at the limit
    expect(defaultApi.text.truncate("abc", { maxLength: 3 })).toBe("abc")
    expect(defaultApi.text.truncate("", { maxLength: 1 })).toBe("")
    expect(defaultApi.text.truncate("abcdef", { maxLength: 4 })).toBe("abc…")
    expect(defaultApi.text.truncate("abcdef", { maxLength: 4, suffix: "..." })).toBe("a...")
    expect(defaultApi.text.truncate("abcdef", { maxLength: 4, suffix: "" })).toBe("abcd")
    expect(defaultApi.text.truncate("abcdef", { maxLength: 4, suffix: undefined as never })).toBe("abc…")
    // No trimming or word boundary: The cut is exact
    expect(defaultApi.text.truncate("ab cd", { maxLength: 4 })).toBe("ab …")
    // The pair at the cut is dropped rather than split, which leaves the result one unit short
    expect(defaultApi.text.truncate("ab😀c", { maxLength: 4 })).toBe("ab…")
    expect(defaultApi.text.truncate("ab😀cde", { maxLength: 5 })).toBe("ab😀…")
    expect(defaultApi.text.truncate("ab😀c", { maxLength: 3, suffix: "" })).toBe("ab")
    // With no room for text before the suffix, the suffix alone is returned
    expect(defaultApi.text.truncate("😀😀", { maxLength: 2 })).toBe("…")
    expect(defaultApi.text.truncate("😀😀", { maxLength: 2, suffix: "ab" })).toBe("ab")
    expect(defaultApi.text.truncate("😀😀", { maxLength: 1 })).toBe("…")
    expect(defaultApi.text.truncate("abc", { maxLength: 1, suffix: "" })).toBe("a")
    // A seeded sequence of mixed text always fits, stays well formed and keeps a prefix of the input
    let seed = 12_345
    const next = (limit: number) => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
        return seed % limit
    }
    const alphabet = ["a", " ", "\n", "é", "😀", "👨‍👩‍👧‍👦", "́"]
    for (let round = 0; round < 500; round++) {
        const content = Array.from({ length: next(30) }, () => alphabet[next(alphabet.length)]).join("")
        const suffix = ["…", "", "...", "😀"][next(4)]!
        const maxLength = Math.max(1, suffix.length) + next(12)
        const result = defaultApi.text.truncate(content, { maxLength, suffix })
        expect(result.length).toBeLessThanOrEqual(maxLength)
        expect(result.isWellFormed()).toBe(true)
        if (content.length <= maxLength) {
            expect(result).toBe(content)
            continue
        }
        expect(result.endsWith(suffix)).toBe(true)
        const kept = result.slice(0, result.length - suffix.length)
        expect(content.startsWith(kept)).toBe(true)
        // The kept text ends between visible characters
        expect(isGraphemeBoundary(content, kept.length)).toBe(true)
    }
})

test("truncate cuts between visible characters", () => {
    const truncate = (content: string, maxLength: number, suffix = "") =>
        defaultApi.text.truncate(content, { maxLength, suffix })
    // A flag is two regional indicators, four units, and is dropped whole
    expect(truncate("aaaaaaaaa🇩🇪", 11)).toBe("aaaaaaaaa")
    expect(truncate("aaaaaaaaa🇩🇪", 13)).toBe("aaaaaaaaa🇩🇪")
    expect(truncate("aaaa🇩🇪b", 7, "…")).toBe("aaaa…")
    // A skin tone, a joined emoji and a combining mark stay with their base
    expect(truncate("ab👍🏽c", 5)).toBe("ab")
    expect(truncate("ab👍🏽c", 6)).toBe("ab👍🏽")
    expect(truncate("ab👨‍👩‍👧‍👦c", 10)).toBe("ab")
    expect(truncate("ab👨‍👩‍👧‍👦c", 13)).toBe("ab👨‍👩‍👧‍👦")
    expect(truncate("abe\u0301c", 3)).toBe("ab")
    expect(truncate("abe\u0301c", 4)).toBe("abe\u0301")
    // A carriage return and the line feed after it are one character
    expect(truncate("ab\r\ncd", 3)).toBe("ab")
    expect(truncate("ab\r\ncd", 4)).toBe("ab\r\n")
    // A first character that does not fit in the room is never cut, so the suffix alone is returned
    const long = "e" + "\u0301".repeat(50)
    expect(truncate(long + "x", 10)).toBe("")
    expect(truncate(long + "x", 10, "…")).toBe("…")
    expect(truncate("😀".repeat(3) + "\u0301".repeat(50), 4)).toBe("😀😀")
    expect(truncate("\u{1F1E9}" + "\u0301".repeat(50), 2)).toBe("")
    expect(truncate("🇩🇪x", 4, "…")).toBe("…")
    expect(truncate("🇩🇪x", 4, "")).toBe("🇩🇪")
    expect(truncate("🇩🇪x", 3, "")).toBe("")
    // With no room for text, the suffix alone is returned
    expect(truncate("🇩🇪🇩🇪", 1, "…")).toBe("…")
})

test("split cuts a single huge character without scanning it again for every piece", () => {
    const prototype = Object.getPrototypeOf(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(""))
    const containing = vi.spyOn(prototype, "containing")
    try {
        const content = "e" + "\u0301".repeat(10_000)
        const pieces = defaultApi.text.split(content, { maxLength: 10 })
        expect(pieces).toHaveLength(1_001)
        expect(pieces.join("")).toBe(content)
        expect(pieces.every((piece) => piece.length <= 10)).toBe(true)
        // One lookup for the character, not one per piece
        expect(containing.mock.calls.length).toBeLessThan(10)
    } finally {
        containing.mockRestore()
    }
})

test.each([
    ["default", defaultApi.text],
    ["native", native.text],
])("%s text helpers replace each lone surrogate instead of failing", (_mode, text) => {
    // Slicing through an emoji leaves its first half, which Fluxer refuses in a message
    const sliced = "Hello 😀 world".slice(0, 7)
    expect(sliced.isWellFormed()).toBe(false)
    expect(text.truncate(sliced, { maxLength: 100 })).toBe("Hello �")
    expect(text.split(sliced, { maxLength: 100 })).toEqual(["Hello �"])

    // A replacement keeps both neighbors apart, where removal would join them into new text
    expect(text.truncate("@every\ud83done", { maxLength: 100 })).toBe("@every�one")
    expect(text.split("a\udc00b", { maxLength: 100 })).toEqual(["a�b"])
    // Whole emoji stay whole next to fragments
    expect(text.truncate("😀\ud83d😀", { maxLength: 100 })).toBe("😀�😀")

    // The replacement has the same length, so limits hold and the suffix still marks a cut
    const long = `${"x".repeat(10)}\ud83d${"y".repeat(10)}`
    const cut = text.truncate(long, { maxLength: 15 })
    expect(cut).toBe(`${"x".repeat(10)}�yyy…`)
    expect(cut).toHaveLength(15)
    const pieces = text.split(long, { maxLength: 4 })
    expect(pieces.join("")).toBe(long.toWellFormed())
    expect(pieces.every((piece) => piece.length <= 4 && piece.isWellFormed())).toBe(true)

    // A suffix is the developer's own text, so a broken one still fails
    expect(thrown(() => text.truncate(long, { maxLength: 15, suffix: "\ud83d" }))).toMatchObject({ reason: "limit" })
})

test("truncate rejects invalid text and options with HelperError", () => {
    expect(thrown(() => defaultApi.text.truncate(1 as never, { maxLength: 4 }))).toMatchObject({
        operation: "text.truncate",
        reason: "text",
    })
    for (const options of [
        undefined,
        null,
        [],
        { maxLength: 0 },
        { maxLength: -1 },
        { maxLength: 1.5 },
        { maxLength: "4" },
        { maxLength: Infinity },
        { maxLength: 4, unknown: true },
        { maxLength: 4, suffix: 1 },
        { maxLength: 4, suffix: null },
        { maxLength: 4, suffix: "\ud800" },
        // The suffix must fit in the limit
        { maxLength: 2, suffix: "..." },
    ])
        expect(thrown(() => defaultApi.text.truncate("private-text", options as never))).toMatchObject({
            operation: "text.truncate",
            reason: "limit",
        })
    const error = thrown(() => defaultApi.text.truncate("private-text", { maxLength: 0 })) as Error
    expect(error.message).not.toContain("private-text")
})
