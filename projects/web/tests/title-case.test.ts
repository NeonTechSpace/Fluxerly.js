import assert from "node:assert/strict"
import { test } from "node:test"
import { titleCase } from "../src/lib/title-case.ts"

test("capitalizes a title and keeps its joining words lower", () => {
    assert.equal(titleCase("commands with the plumbing done"), "Commands with the Plumbing Done")
    assert.equal(titleCase("from one file to a full application"), "From One File to a Full Application")
})

test("capitalizes the first and last word whatever they are", () => {
    assert.equal(titleCase("a bot worth coming back to"), "A Bot Worth Coming Back To")
    assert.equal(titleCase("where do I…?"), "Where Do I…?")
})

test("leaves words that carry their own spelling", () => {
    assert.equal(titleCase("publish to npm with OAuth and bot.ts"), "Publish to npm with OAuth and bot.ts")
    assert.equal(titleCase("Node.js and module system"), "Node.js and Module System")
})

test("treats each side of a hyphen as a word", () => {
    assert.equal(titleCase("permission-aware work"), "Permission-Aware Work")
})

test("capitalizes after a colon", () => {
    assert.equal(titleCase("next: a real application"), "Next: A Real Application")
})

test("a split heading lowers its joining words where inline code touches them", () => {
    assert.equal(titleCase("use the ", { last: false }), "Use the ")
    assert.equal(titleCase(" in a bot", { first: false }), " in a Bot")
    assert.equal(titleCase(" of ", { first: false, last: false }), " of ")
})

test("is stable when applied twice", () => {
    const once = titleCase("read every failure in the log")
    assert.equal(titleCase(once), once)
})
