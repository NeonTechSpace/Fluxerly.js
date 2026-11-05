// Tests that the public word list leaves out profanity, which the spell checker counts as real words near docs words
// such as count and shift, and keeps every other word
import assert from "node:assert/strict"
import { test } from "node:test"
import { shippable } from "../scripts/docs/search-words.mjs"

test("the real-word list leaves out profanity in its plural forms and keeps the words beside it", () => {
    assert.deepEqual(shippable(["count", "cunt", "cunts", "cunting", "shift", "shit", "shits", "shitty", "fags", "pisses", "pissed", "tittle", "assess", "cocktail"]), ["count", "shift", "tittle", "assess", "cocktail"])
})
