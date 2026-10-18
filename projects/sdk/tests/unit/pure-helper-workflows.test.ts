import { afterEach, expect, test, vi } from "vitest"
import * as defaultApi from "../../src/index.js"
import * as native from "../../src/effect.js"

afterEach(() => vi.unstubAllGlobals())

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

for (const [mode, api] of [
    ["default", defaultApi],
    ["effect", native],
] as const) {
    test(`${mode}: composes and inspects raw permission sets without discarding unknown bits or expanding Administrator`, () => {
        vi.stubGlobal("fetch", () => {
            throw Error("Pure helpers must not fetch")
        })
        const bits = api.permissionBits.from(["ManageMessages", "ManageRoles", "ManageMessages"])
        expect(bits).toBe(api.Permissions.ManageMessages | api.Permissions.ManageRoles)
        expect(api.permissionBits.from([])).toBe(0n)
        expect(api.permissionBits.hasAll(bits, ["ManageRoles", "ManageMessages"])).toBe(true)
        expect(api.permissionBits.hasAll(bits, ["BanMembers", "ManageMessages"])).toBe(false)
        expect(api.permissionBits.hasAny(bits, ["BanMembers", "ManageMessages"])).toBe(true)
        expect(api.permissionBits.hasAny(bits, ["BanMembers"])).toBe(false)
        expect(api.permissionBits.hasAll(bits, [])).toBe(true)
        expect(api.permissionBits.hasAny(bits, [])).toBe(false)
        expect(api.permissionBits.hasAll(api.Permissions.Administrator, ["ManageRoles"])).toBe(false)
        const missing = api.permissionBits.missing(bits, ["BanMembers", "KickMembers", "BanMembers", "ManageRoles"])
        expect(missing).toEqual(["BanMembers", "KickMembers"])
        expect(Object.isFrozen(missing)).toBe(true)
        const unknown = 1n << 63n
        const inspection = api.permissionBits.inspect(bits | unknown)
        expect(inspection).toEqual({ names: ["ManageMessages", "ManageRoles"], unknownBits: unknown })
        expect(api.permissionBits.from(inspection.names) | inspection.unknownBits).toBe(bits | unknown)
        expect(Object.isFrozen(inspection)).toBe(true)
        expect(Object.isFrozen(inspection.names)).toBe(true)
    })

    // Fluxer 4749eb7f ThreadPermissionFlags: Inspection once reported these bits as unknown and names rejected them
    test(`${mode}: names the thread permission bits`, () => {
        const threadBits = (1n << 34n) | (1n << 35n) | (1n << 36n) | (1n << 38n)
        const names = ["ManageThreads", "CreatePublicThreads", "CreatePrivateThreads", "SendMessagesInThreads"] as const
        expect(api.permissionBits.from(names)).toBe(threadBits)
        expect(api.permissionBits.inspect(threadBits)).toEqual({ names, unknownBits: 0n })
        expect(api.guards.requirePermissions(["SendMessagesInThreads"])).toBeTypeOf("function")
    })

    test(`${mode}: validates every permission name and unsigned-64-bit input without leaking rejected values`, () => {
        for (const names of [["ManageRoles", "secret-invalid-name"], ["toString"], Array(1), null]) {
            for (const operation of [
                () => api.permissionBits.from(names as never),
                () => api.permissionBits.hasAll(0n, names as never),
                () => api.permissionBits.hasAny(api.Permissions.ManageRoles, names as never),
                () => api.permissionBits.missing(0n, names as never),
            ]) {
                const error = thrown(operation)
                expect(error).toMatchObject({ _tag: "HelperError", reason: "permissionBits" })
                expect(JSON.stringify(error)).not.toContain("secret-invalid-name")
            }
        }
        for (const bits of [-1n, 1n << 64n, 1, "1", null]) {
            for (const operation of [
                () => api.permissionBits.hasAll(bits as never, []),
                () => api.permissionBits.hasAny(bits as never, []),
                () => api.permissionBits.missing(bits as never, []),
                () => api.permissionBits.inspect(bits as never),
            ])
                expect(thrown(operation)).toMatchObject({ _tag: "HelperError", reason: "permissionBits" })
        }
    })

    test(`${mode}: converts color configuration in both directions and rejects coercion or lossy inputs`, () => {
        vi.stubGlobal("fetch", () => {
            throw Error("Pure helpers must not fetch")
        })
        for (const input of ["#ff8800", "FF8800", 0xff8800, [255, 136, 0]] as const)
            expect(api.colors.parse(input)).toBe(0xff8800)
        expect(api.colors.toHex(1)).toBe("#000001")
        expect(api.colors.toHex(0xffffff)).toBe("#ffffff")
        const rgb = api.colors.toRgb(0xff8800)
        expect(rgb).toEqual([255, 136, 0])
        expect(Object.isFrozen(rgb)).toBe(true)
        expect(api.colors.parse(rgb)).toBe(0xff8800)
        const alternating: [number, number, number] = [0, 0, 0]
        let greenReads = 0
        Object.defineProperty(alternating, 1, {
            get: () => (greenReads++ === 0 ? 1 : 999),
            enumerable: true,
        })
        expect(api.colors.parse(alternating)).toBe(0x000100)
        expect(greenReads).toBe(1)
        const iteratorMasked = [0, 999, 0]
        Object.defineProperty(iteratorMasked, Symbol.iterator, {
            value: function* () {
                yield 0
                yield 0
                yield 0
            },
        })
        expect(thrown(() => api.colors.parse(iteratorMasked as never))).toMatchObject({
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
            expect(thrown(() => api.colors.parse(input as never))).toMatchObject({
                operation: "colors.parse",
                reason: "color",
            })
        for (const input of [-1, 0x1000000, 1.5, NaN, "1"])
            for (const operation of [() => api.colors.toHex(input as never), () => api.colors.toRgb(input as never)])
                expect(thrown(operation)).toMatchObject({ reason: "color" })
    })

    test(`${mode}: splits losslessly at line, word and surrogate-safe hard boundaries`, () => {
        vi.stubGlobal("fetch", () => {
            throw Error("Pure helpers must not fetch")
        })
        expect(api.text.split("", { maxLength: 3 })).toEqual([])
        expect(api.text.split("ab\ncd ef", { maxLength: 7 })).toEqual(["ab\n", "cd ef"])
        expect(api.text.split("one two three", { maxLength: 8 })).toEqual(["one two ", "three"])
        expect(api.text.split("abcd", { maxLength: 2 })).toEqual(["ab", "cd"])
        const content = "A🦊e\u0301\r\n👨‍👩‍👧‍👦 `code` @everyone\t"
        for (let maxLength = 2; maxLength < 15; maxLength++) {
            const parts = api.text.split(content, { maxLength })
            expect(parts.join("")).toBe(content)
            expect(parts.every((piece) => piece.length > 0 && piece.length <= maxLength && piece.isWellFormed())).toBe(
                true,
            )
            expect(Object.isFrozen(parts)).toBe(true)
        }
        expect(thrown(() => api.text.split("🦊", { maxLength: 1 }))).toMatchObject({ reason: "limit" })
        expect(thrown(() => api.text.split("\ud800", { maxLength: 2 }))).toMatchObject({ reason: "text" })
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
            expect(thrown(() => api.text.split("private-text", options as never))).toMatchObject({
                operation: "text.split",
                reason: "limit",
            })
        expect(thrown(() => api.text.split(1 as never, { maxLength: 2 }))).toMatchObject({ reason: "text" })
    })

    test(`${mode}: truncates to the limit with a suffix, keeping surrogate pairs whole`, () => {
        vi.stubGlobal("fetch", () => {
            throw Error("Pure helpers must not fetch")
        })
        // Text that fits is returned unchanged, even when it ends exactly at the limit
        expect(api.text.truncate("abc", { maxLength: 3 })).toBe("abc")
        expect(api.text.truncate("", { maxLength: 1 })).toBe("")
        expect(api.text.truncate("abcdef", { maxLength: 4 })).toBe("abc…")
        expect(api.text.truncate("abcdef", { maxLength: 4, suffix: "..." })).toBe("a...")
        expect(api.text.truncate("abcdef", { maxLength: 4, suffix: "" })).toBe("abcd")
        expect(api.text.truncate("abcdef", { maxLength: 4, suffix: undefined as never })).toBe("abc…")
        // No trimming or word boundary: The cut is exact
        expect(api.text.truncate("ab cd", { maxLength: 4 })).toBe("ab …")
        // The pair at the cut is dropped rather than split, which leaves the result one unit short
        expect(api.text.truncate("ab😀c", { maxLength: 4 })).toBe("ab…")
        expect(api.text.truncate("ab😀cde", { maxLength: 5 })).toBe("ab😀…")
        expect(api.text.truncate("ab😀c", { maxLength: 3, suffix: "" })).toBe("ab")
        // With no room for text before the suffix, the suffix alone is returned
        expect(api.text.truncate("😀😀", { maxLength: 2 })).toBe("…")
        expect(api.text.truncate("😀😀", { maxLength: 2, suffix: "ab" })).toBe("ab")
        expect(api.text.truncate("😀😀", { maxLength: 1 })).toBe("…")
        expect(api.text.truncate("abc", { maxLength: 1, suffix: "" })).toBe("a")
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
            const result = api.text.truncate(content, { maxLength, suffix })
            expect(result.length).toBeLessThanOrEqual(maxLength)
            expect(result.isWellFormed()).toBe(true)
            if (content.length <= maxLength) {
                expect(result).toBe(content)
                continue
            }
            expect(result.endsWith(suffix)).toBe(true)
            const kept = result.slice(0, result.length - suffix.length)
            expect(content.startsWith(kept)).toBe(true)
            // Only a pair that straddles the cut may shorten the kept text, and then by one unit
            expect(maxLength - suffix.length - kept.length).toBeLessThanOrEqual(1)
        }
    })

    test(`${mode}: truncate rejects invalid text and options with HelperError`, () => {
        expect(thrown(() => api.text.truncate("\ud800", { maxLength: 4 }))).toMatchObject({
            operation: "text.truncate",
            reason: "text",
        })
        expect(thrown(() => api.text.truncate(1 as never, { maxLength: 4 }))).toMatchObject({ reason: "text" })
        expect(api.text.truncate("\ud800".toWellFormed(), { maxLength: 4 })).toBe("�")
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
            expect(thrown(() => api.text.truncate("private-text", options as never))).toMatchObject({
                operation: "text.truncate",
                reason: "limit",
            })
        const error = thrown(() => api.text.truncate("private-text", { maxLength: 0 })) as Error
        expect(error.message).not.toContain("private-text")
    })
}
