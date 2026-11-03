// Tests the condensed text reference for AI tools against the reference model: whole first sentences, rest parameters
// that take any number of arguments, static members and exports without a category, on small fixtures and on the
// generated model itself
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import type { Entry, Member, Signature } from "../src/lib/reference.ts"
import { checkedText, firstSentence, referenceText, referenceTextProblems, shownSentence, tasksMarkdown } from "../src/lib/reference-text.ts"

const context = { about: "Fixture", absolute: (url: string) => `https://example.test${url}` }
const stringType = "string"

function entry(members: Member[], extra: Partial<Entry> = {}): Entry {
    return {
        key: "js-ts",
        title: "Fixture",
        importPath: "fixture",
        url: "/docs/api/js-ts/",
        doc: {},
        categories: [
            {
                title: "Things",
                slug: "things",
                url: "/docs/api/js-ts/things/",
                top: [],
                items: [{ kind: "class", name: "Thing", anchor: "thing", url: "/docs/api/js-ts/things/#thing", members }],
            },
        ],
        uncategorized: [],
        ...extra,
    }
}
const method = (name: string, signature: Signature, extra: Partial<Member> = {}): Member => ({ kind: "method", name, signatures: [signature], ...extra })

test("a description wrapped across lines keeps its whole first sentence", () => {
    const summary = "Stored period, in minutes, such as\nThreadAutoArchiveMinutes.OneDay. Fluxer sends it only when stored"
    assert.equal(firstSentence(summary), "Stored period, in minutes, such as ThreadAutoArchiveMinutes.OneDay.")
    assert.equal(firstSentence("One line without an end\nthat goes on\n\nA second paragraph"), "One line without an end that goes on")
    const fixture = entry([{ kind: "property", name: "period", type: stringType, doc: { summary } }])
    // The text ends no line with a period, while the sentence keeps its own dots
    assert.match(referenceText([fixture], context), /such as ThreadAutoArchiveMinutes\.OneDay$/m)
    assert.deepEqual(referenceTextProblems([fixture]), [])
})

test("the text drops one final period and keeps other sentence ends", () => {
    assert.equal(shownSentence("Return a new empty EmbedBuilder. It has no fields"), "Return a new empty EmbedBuilder")
    assert.equal(shownSentence("Is the member cached? Only the cache is read"), "Is the member cached?")
    assert.equal(shownSentence("Stop now! Nothing else runs"), "Stop now!")
    assert.equal(shownSentence("Wait for it..."), "Wait for it...")
    assert.equal(shownSentence("Uses client.messages.send without a period"), "Uses client.messages.send without a period")
    const lines = (summary: string) => referenceText([entry([{ kind: "property", name: "thing", type: stringType, doc: { summary } }], { doc: {} })], context)
    assert.match(lines("Build hosted Fluxer URLs for avatars. Then more"), /^- `thing: string`: Build hosted Fluxer URLs for avatars$/m)
})

test("a rest parameter shown with a fixed-length type is a problem", () => {
    const tuple = (rest: boolean) =>
        ({
            k: "op",
            op: "readonly",
            t: { k: "tuple", t: rest ? [{ k: "named", n: "first", t: stringType }, { k: "rest", t: { k: "arr", t: stringType } }] : [stringType, stringType] },
        }) as never
    const signature = (rest: boolean): Signature => ({ p: [{ n: "values", r: 1, t: tuple(rest) }], r: stringType })
    const lost = referenceTextProblems([entry([method("addStickers", signature(false))])])
    assert.equal(lost.length, 1)
    assert.match(lost[0]!, /Rest parameter values has the fixed-length type/)
    const kept = entry([method("addStickers", signature(true))])
    assert.deepEqual(referenceTextProblems([kept]), [], referenceText([kept], context))
    assert.deepEqual(referenceTextProblems([entry([method("add", { p: [{ n: "values", r: 1, t: { k: "arr", t: stringType } as never }], r: stringType })])]), [])
})

test("a static member is marked in the text", () => {
    const fixture = entry([method("layer", { p: [], r: stringType }, { static: true }), method("send", { p: [], r: stringType })])
    const text = referenceText([fixture], context)
    assert.match(text, /- `static layer\(\): string`/)
    assert.match(text, /- `send\(\): string`/)
    assert.deepEqual(referenceTextProblems([fixture]), [])
})

test("an export without a category is a problem, since the text leaves it out", () => {
    const fixture = entry([], { uncategorized: [{ kind: "function", name: "orphan", anchor: "orphan", url: "/docs/api/js-ts/#orphan" }] })
    assert.deepEqual(referenceTextProblems([fixture]), ["Fixture orphan: The export has no @category, so the text reference leaves it out"])
    assert.throws(() => checkedText("text", referenceTextProblems([fixture])), /orphan/)
})

test("the generated model gives a text reference and task list with no problems", () => {
    const model = JSON.parse(readFileSync(new URL("../content/reference/model.json", import.meta.url), "utf8")) as { entries: Entry[] }
    assert.deepEqual(referenceTextProblems(model.entries), [])
    assert.match(tasksMarkdown(model.entries, context), /^# Every client method by task/)
    // Public text ends no line with a period. A type cut short ends with an ellipsis instead
    const periodLines = (text: string) => text.split("\n").filter((line) => /(?<!\.)\.$/.test(line))
    assert.deepEqual(periodLines(referenceText(model.entries, context)), [])
    assert.deepEqual(periodLines(tasksMarkdown(model.entries, context)), [])
})
