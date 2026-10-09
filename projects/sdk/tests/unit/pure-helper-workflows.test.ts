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
}
