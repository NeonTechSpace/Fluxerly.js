import assert from "node:assert/strict"
import { test } from "node:test"
import { PlaneGeometry, Texture, type TextureLoader } from "three"
import { createCompanions } from "../src/scene/companions.ts"

// Catches: On a phone, choosing Still disposed the companions but kept their wait for a wider window, so widening or
// rotating later still downloaded the icons and every animation part while the page stayed Still

/** A stand-in for the stacked-layout media query whose change listeners the test can count and fire */
function fakeQuery(matches: boolean) {
    const listeners = new Set<() => void>()
    const query = {
        matches,
        addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
    }
    return { query, listeners }
}

test("disposed companions stop waiting for a wider window and load nothing more", async () => {
    const { query, listeners } = fakeQuery(true)
    const globals = globalThis as { window?: unknown }
    const previous = globals.window
    globals.window = { matchMedia: () => query }
    try {
        let loads = 0
        const loader = {
            loadAsync: async () => {
                loads++
                return new Texture()
            },
        } as unknown as TextureLoader
        const companions = createCompanions(new PlaneGeometry(), { far: 1, mid: 1, near: 1 }, { far: 1, mid: 2, near: 3 })
        assert.deepEqual(await companions.load(loader, 800, 1), [])
        await companions.loadParts(loader)
        assert.equal(listeners.size, 1)
        companions.dispose()
        assert.equal(listeners.size, 0)
        // The window widens after Still was chosen
        query.matches = false
        for (const listener of listeners) listener()
        await companions.load(loader, 800, 1)
        await companions.loadParts(loader)
        assert.equal(loads, 0)
    } finally {
        globals.window = previous
    }
})

// Catches: When a narrow window widened, the icons loaded late with no handler, so a failed download became an
// unhandled rejection instead of the warning the first load gives. Also: A failed icon download, which leaves the icons
// unplaced and can keep them hidden, gave the warning of failed animation parts, which said the icons stayed whole
async function lateLoadOutcome(failing: "whole icons" | "animation parts"): Promise<string> {
    const { query, listeners } = fakeQuery(true)
    const globals = globalThis as { window?: unknown }
    const previous = globals.window
    const warn = console.warn
    globals.window = { matchMedia: () => query }
    let unhandled: (reason: unknown) => void = () => {}
    const onUnhandled = (reason: unknown) => unhandled(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
        const loader = {
            loadAsync: async (url: string) => {
                if (failing === "whole icons" || url.includes("/parts/")) throw new Error(`fixture failure ${url}`)
                return new Texture()
            },
        } as unknown as TextureLoader
        const companions = createCompanions(new PlaneGeometry(), { far: 1, mid: 1, near: 1 }, { far: 1, mid: 2, near: 3 })
        await companions.load(loader, 800, 1)
        await companions.loadParts(loader)
        // Whichever comes first: The warning, or the rejection nothing handled
        const outcome = new Promise<string>((resolve) => {
            console.warn = (message: unknown) => resolve(String(message))
            unhandled = () => resolve("unhandled rejection")
        })
        query.matches = false
        for (const listener of listeners) listener()
        return await outcome
    } finally {
        console.warn = warn
        process.off("unhandledRejection", onUnhandled)
        globals.window = previous
    }
}

test("a failed late load after the window widens is reported, and failed icons and failed parts are told apart", async () => {
    const icons = await lateLoadOutcome("whole icons")
    const parts = await lateLoadOutcome("animation parts")
    for (const outcome of [icons, parts]) assert.notEqual(outcome, "unhandled rejection")
    assert.notEqual(icons, parts)
})
