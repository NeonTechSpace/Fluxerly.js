// Tests what Enter opens in the docs search dialog when the shown results still answer an earlier query
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Hit } from "../src/lib/docs-search.ts"
import { composing, EnterIntent } from "../src/lib/search-enter.ts"

const hit = (url: string): Hit => ({ url, title: url, excerpt: "" })
const prefix = [hit("/docs/api/js-ts/client/#client-conn"), hit("/docs/other/")]
const fresh = [hit("/docs/api/js-ts/client/#client-connect"), hit("/docs/second/")]

test("Enter opens the active result when the results answer the query as typed", () => {
    const enter = new EnterIntent()
    assert.equal(enter.press("client.connect", "client.connect", fresh, 1), fresh[1])
    assert.equal(enter.arrive("client.connect", fresh), undefined)
})

test("Enter before the query's results arrive opens nothing from an earlier query, then the first new result", () => {
    const enter = new EnterIntent()
    assert.equal(enter.press("client.connect", "client.conn", prefix, 0), undefined)
    // A prefix answered late belongs to another query
    assert.equal(enter.arrive("client.conn", prefix), undefined)
    assert.equal(enter.arrive("client.connect", fresh), fresh[0])
    // Enter opens once
    assert.equal(enter.arrive("client.connect", fresh), undefined)
})

test("a changed query, a failed search or a closed dialog cancels a waiting Enter", () => {
    const enter = new EnterIntent()
    enter.press("client.connect", "client.conn", prefix, 0)
    enter.clear()
    assert.equal(enter.arrive("client.connect", fresh), undefined)
})

test("results with nothing found open nothing", () => {
    const enter = new EnterIntent()
    enter.press("zzzz", "zzz", prefix, 0)
    assert.equal(enter.arrive("zzzz", []), undefined)
})

test("a key that an input method is composing with is left to the input method", () => {
    assert.equal(composing({ isComposing: true, keyCode: 13 }), true)
    // Some browsers mark a composing key only with key code 229
    assert.equal(composing({ isComposing: false, keyCode: 229 }), true)
    assert.equal(composing({ keyCode: 229 }), true)
    assert.equal(composing({ isComposing: false, keyCode: 13 }), false)
    assert.equal(composing({}), false)
})
