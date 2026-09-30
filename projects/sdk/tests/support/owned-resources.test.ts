import { setImmediate as turn } from "node:timers/promises"
import { expect, onTestFinished, test } from "vitest"
import { ownedResources } from "./owned-resources.js"

test("resource tracking ignores unrelated timers without letting them cancel out an owned timer", async () => {
    const resources = ownedResources()
    const unrelated = setTimeout(() => {}, 60_000)
    const owned = resources.run(() => setTimeout(() => {}, 60_000))
    onTestFinished(() => {
        clearTimeout(unrelated)
        clearTimeout(owned)
    })
    expect(resources.remaining()).toEqual(["Timeout"])
    clearTimeout(unrelated)
    await turn()
    expect(resources.remaining()).toEqual(["Timeout"])
    clearTimeout(owned)
    await resources.released()
    expect(resources.remaining()).toEqual([])
})

test("resource tracking follows descendants of owned asynchronous work", async () => {
    const resources = ownedResources()
    const owned = await resources.run(async () => {
        await turn()
        return setTimeout(() => {}, 60_000)
    })
    onTestFinished(() => clearTimeout(owned))
    expect(resources.remaining()).toEqual(["Timeout"])
    clearTimeout(owned)
    await resources.released()
    expect(resources.remaining()).toEqual([])
})
