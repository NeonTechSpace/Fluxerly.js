import { Effect, Exit } from "effect"
import type { Result } from "neverthrow"
import { afterEach, expect, test, vi } from "vitest"
import * as defaultApi from "../src/index.js"
import * as native from "../src/effect.js"

afterEach(() => vi.unstubAllGlobals())

async function value<A>(
    operation: Result<A, defaultApi.HelperError> | Effect.Effect<A, defaultApi.HelperError>,
): Promise<A> {
    if (Effect.isEffect(operation)) return Effect.runPromise(operation)
    if (operation.isErr()) throw operation.error
    return operation.value
}

async function failure(
    operation: Result<unknown, defaultApi.HelperError> | Effect.Effect<unknown, defaultApi.HelperError>,
) {
    if (!Effect.isEffect(operation)) {
        if (operation.isOk()) throw Error("Expected helper failure")
        return operation.error
    }
    const exit = await Effect.runPromiseExit(operation)
    if (Exit.isSuccess(exit)) throw Error("Expected helper failure")
    const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (reason?._tag !== "Fail") throw Error("Expected typed helper failure")
    return reason.error
}

for (const [mode, api] of [
    ["default", defaultApi],
    ["effect", native],
] as const) {
    test(`${mode}: composes and inspects raw permission sets without discarding unknown bits or expanding Administrator`, async () => {
        vi.stubGlobal("fetch", () => {
            throw Error("Pure helpers must not fetch")
        })
        const bits = await value(api.permissionBits.from(["ManageMessages", "ManageRoles", "ManageMessages"]))
        expect(bits).toBe(api.Permissions.ManageMessages | api.Permissions.ManageRoles)
        expect(await value(api.permissionBits.from([]))).toBe(0n)
        expect(await value(api.permissionBits.hasAll(bits, ["ManageRoles", "ManageMessages"]))).toBe(true)
        expect(await value(api.permissionBits.hasAll(bits, ["BanMembers", "ManageMessages"]))).toBe(false)
        expect(await value(api.permissionBits.hasAny(bits, ["BanMembers", "ManageMessages"]))).toBe(true)
        expect(await value(api.permissionBits.hasAny(bits, ["BanMembers"]))).toBe(false)
        expect(await value(api.permissionBits.hasAll(bits, []))).toBe(true)
        expect(await value(api.permissionBits.hasAny(bits, []))).toBe(false)
        expect(await value(api.permissionBits.hasAll(api.Permissions.Administrator, ["ManageRoles"]))).toBe(false)
        const missing = await value(
            api.permissionBits.missing(bits, ["BanMembers", "KickMembers", "BanMembers", "ManageRoles"]),
        )
        expect(missing).toEqual(["BanMembers", "KickMembers"])
        expect(Object.isFrozen(missing)).toBe(true)
        const unknown = 1n << 63n
        const inspection = await value(api.permissionBits.inspect(bits | unknown))
        expect(inspection).toEqual({ names: ["ManageMessages", "ManageRoles"], unknownBits: unknown })
        expect((await value(api.permissionBits.from(inspection.names))) | inspection.unknownBits).toBe(bits | unknown)
        expect(Object.isFrozen(inspection)).toBe(true)
        expect(Object.isFrozen(inspection.names)).toBe(true)
    })

    test(`${mode}: validates every permission name and unsigned-64-bit input without leaking rejected values`, async () => {
        for (const names of [["ManageRoles", "secret-invalid-name"], ["toString"], Array(1), null]) {
            for (const operation of [
                api.permissionBits.from(names as never),
                api.permissionBits.hasAll(0n, names as never),
                api.permissionBits.hasAny(api.Permissions.ManageRoles, names as never),
                api.permissionBits.missing(0n, names as never),
            ]) {
                const error = await failure(operation)
                expect(error).toMatchObject({ _tag: "HelperError", reason: "permissionBits" })
                expect(JSON.stringify(error)).not.toContain("secret-invalid-name")
            }
        }
        for (const bits of [-1n, 1n << 64n, 1, "1", null]) {
            for (const operation of [
                api.permissionBits.hasAll(bits as never, []),
                api.permissionBits.hasAny(bits as never, []),
                api.permissionBits.missing(bits as never, []),
                api.permissionBits.inspect(bits as never),
            ])
                expect(await failure(operation)).toMatchObject({ _tag: "HelperError", reason: "permissionBits" })
        }
    })

    test(`${mode}: converts color configuration in both directions and rejects coercion or lossy inputs`, async () => {
        vi.stubGlobal("fetch", () => {
            throw Error("Pure helpers must not fetch")
        })
        for (const input of ["#ff8800", "FF8800", 0xff8800, [255, 136, 0]] as const)
            expect(await value(api.colors.parse(input))).toBe(0xff8800)
        expect(await value(api.colors.toHex(1))).toBe("#000001")
        expect(await value(api.colors.toHex(0xffffff))).toBe("#ffffff")
        const rgb = await value(api.colors.toRgb(0xff8800))
        expect(rgb).toEqual([255, 136, 0])
        expect(Object.isFrozen(rgb)).toBe(true)
        expect(await value(api.colors.parse(rgb))).toBe(0xff8800)
        const alternating: [number, number, number] = [0, 0, 0]
        let greenReads = 0
        Object.defineProperty(alternating, 1, {
            get: () => (greenReads++ === 0 ? 1 : 999),
            enumerable: true,
        })
        expect(await value(api.colors.parse(alternating))).toBe(0x000100)
        expect(greenReads).toBe(1)
        const iteratorMasked = [0, 999, 0]
        Object.defineProperty(iteratorMasked, Symbol.iterator, {
            value: function* () {
                yield 0
                yield 0
                yield 0
            },
        })
        expect(await failure(api.colors.parse(iteratorMasked as never))).toMatchObject({
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
            expect(await failure(api.colors.parse(input as never))).toMatchObject({
                operation: "colors.parse",
                reason: "color",
            })
        for (const input of [-1, 0x1000000, 1.5, NaN, "1"])
            for (const operation of [api.colors.toHex(input as never), api.colors.toRgb(input as never)])
                expect(await failure(operation)).toMatchObject({ reason: "color" })
    })

    test(`${mode}: splits losslessly at line, word and surrogate-safe hard boundaries`, async () => {
        vi.stubGlobal("fetch", () => {
            throw Error("Pure helpers must not fetch")
        })
        expect(await value(api.text.split("", { maxLength: 3 }))).toEqual([])
        expect(await value(api.text.split("ab\ncd ef", { maxLength: 7 }))).toEqual(["ab\n", "cd ef"])
        expect(await value(api.text.split("one two three", { maxLength: 8 }))).toEqual(["one two ", "three"])
        expect(await value(api.text.split("abcd", { maxLength: 2 }))).toEqual(["ab", "cd"])
        const content = "A🦊e\u0301\r\n👨‍👩‍👧‍👦 `code` @everyone\t"
        for (let maxLength = 2; maxLength < 15; maxLength++) {
            const parts = await value(api.text.split(content, { maxLength }))
            expect(parts.join("")).toBe(content)
            expect(parts.every((piece) => piece.length > 0 && piece.length <= maxLength && piece.isWellFormed())).toBe(
                true,
            )
            expect(Object.isFrozen(parts)).toBe(true)
        }
        expect(await failure(api.text.split("🦊", { maxLength: 1 }))).toMatchObject({ reason: "limit" })
        expect(await failure(api.text.split("\ud800", { maxLength: 2 }))).toMatchObject({ reason: "text" })
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
            expect(await failure(api.text.split("private-text", options as never))).toMatchObject({
                operation: "text.split",
                reason: "limit",
            })
        expect(await failure(api.text.split(1 as never, { maxLength: 2 }))).toMatchObject({ reason: "text" })
    })
}

test("native pure helpers validate at execution and preserve typed failures", async () => {
    const names: defaultApi.PermissionName[] = ["ManageMessages"]
    const required = native.permissionBits.from(names)
    names.push("ManageRoles")
    expect(await Effect.runPromise(required)).toBe(
        defaultApi.Permissions.ManageMessages | defaultApi.Permissions.ManageRoles,
    )
    const rgb: [number, number, number] = [1, 2, 3]
    const parsed = native.colors.parse(rgb)
    rgb[0] = 4
    expect(await Effect.runPromise(parsed)).toBe(0x040203)
    const options = { maxLength: 3 }
    const split = native.text.split("abcd", options)
    options.maxLength = 2
    expect(await Effect.runPromise(split)).toEqual(["ab", "cd"])
})
