import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parsers } from "prettier/plugins/babel"
import { afterEach, expect, test } from "vitest"
import { createMemberRequestPacing, memberRequestMaxWaitMs } from "./support/member-request-pacing.js"

// Fluxer drops a 13th member request from one bot within 10 seconds without a reply, and the default and Effect runs
// of a check are separate processes. Each pacing instance below stands for one process sharing the record file

const directories = []
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true })
})

function setup() {
    const directory = mkdtempSync(join(tmpdir(), "fluxerly-member-pacing-"))
    directories.push(directory)
    const path = join(directory, "record.json")
    const clock = { time: 1_000_000, waits: [] }
    const startProcess = () =>
        createMemberRequestPacing({
            path,
            now: () => clock.time,
            wait: async (ms) => {
                clock.waits.push(ms)
                clock.time += ms
            },
        })
    return { path, clock, startProcess }
}

test("a second process waits until the first process's requests leave Fluxer's window", async () => {
    const { clock, startProcess } = setup()
    const first = startProcess()
    for (let i = 0; i < 12; i++) {
        await first()
        clock.time += 500
    }
    expect(clock.waits).toEqual([])

    const second = startProcess()
    await second()
    // The oldest of the 12 was sent 6 seconds ago, so one more fits once it is the full window old
    expect(clock.waits).toEqual([memberRequestMaxWaitMs - 6_000])
})

test("requests that already left the window do not delay the next one, and they are dropped from the record", async () => {
    const { path, clock, startProcess } = setup()
    const first = startProcess()
    for (let i = 0; i < 12; i++) await first()
    clock.time += memberRequestMaxWaitMs
    await startProcess()()
    expect(clock.waits).toEqual([])
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([clock.time])
})

test("a malformed record fails instead of pacing nothing", async () => {
    const { path, startProcess } = setup()
    writeFileSync(path, JSON.stringify(["not a time"]))
    await expect(startProcess()()).rejects.toThrow()
})

test("a reservation waits while another process holds the record lock, and releases its own", async () => {
    const { path, clock } = setup()
    const lockPath = `${path}.lock`
    writeFileSync(lockPath, "")
    const reserve = createMemberRequestPacing({
        path,
        now: () => clock.time,
        wait: async (ms) => {
            clock.waits.push(ms)
            // The other process finishes its write and releases the lock while this one waits
            expect(existsSync(path)).toBe(false)
            rmSync(lockPath)
        },
    })
    await reserve()
    expect(clock.waits).toHaveLength(1)
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([clock.time])
    expect(existsSync(lockPath)).toBe(false)
})

test("every live harness function that requests members reserves the request first", async () => {
    const live = new URL("./", import.meta.url)
    let requesters = 0
    for (const file of readdirSync(live).filter((name) => /^[a-z-]+\.m?js$/.test(name))) {
        const source = readFileSync(new URL(file, live), "utf8")
        if (!source.includes("iterateChunks")) continue
        const ast = await parsers.babel.parse(source)
        const functions = []
        ;(function visit(node) {
            if (!node || typeof node !== "object") return
            if (node.type === "FunctionDeclaration") functions.push(node)
            for (const child of Object.values(node))
                if (Array.isArray(child)) child.forEach(visit)
                else visit(child)
        })(ast.program)
        const requests = (node) => source.slice(node.start, node.end).includes("iterateChunks")
        const contains = (outer, inner) => outer !== inner && outer.start <= inner.start && inner.end <= outer.end
        // The innermost functions that send the request
        const requesting = functions.filter(
            (node) => requests(node) && !functions.some((inner) => contains(node, inner) && requests(inner)),
        )
        expect(requesting.length, file).toBeGreaterThan(0)
        for (const node of requesting) {
            requesters++
            // The parsed first statement, so formatting such as a semicolon or line breaks cannot fail the check
            const first = node.body.body[0]
            const call = first?.type === "ExpressionStatement" ? first.expression : undefined
            expect(
                {
                    awaited: call?.type === "AwaitExpression",
                    callee: call?.argument?.type === "CallExpression" ? call.argument.callee : undefined,
                    arguments: call?.argument?.arguments?.length,
                },
                `${file} ${node.id.name}`,
            ).toMatchObject({
                awaited: true,
                callee: { type: "Identifier", name: "reserveMemberRequest" },
                arguments: 0,
            })
        }
    }
    expect(requesters).toBeGreaterThanOrEqual(3)
})
