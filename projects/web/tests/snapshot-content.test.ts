// Published snapshots must build through today's checks without changing the assets or accepting new extraction errors
import assert from "node:assert/strict"
import { test } from "node:test"
import { snapshotContent } from "../scripts/docs/snapshot-content.mjs"
import type { Entry, Type } from "../src/lib/reference.ts"
import { checkedText, referenceText, referenceTextProblems, tasksMarkdown } from "../src/lib/reference-text.ts"
import { typeHtml } from "../src/lib/reference-format.ts"

const stable = { version: "1000.0.0", sourceCommit: "eba7baef00bf5caa6228777ed7732880b0daebfd" }
const attachment: Type = { r: "AttachmentInput", h: "/docs/api/js-ts/messages/#attachmentinput" }
const embed: Type = { k: "union", t: [{ r: "EmbedInput", h: "/docs/api/js-ts/messages/#embedinput" }, { r: "EmbedBuilder", h: "/docs/api/js-ts/embedbuilder/" }] }
const elements: Record<string, Type> = { addAttachments: attachment, addEmbeds: embed, addStickers: "string" }
const context = { about: "Fixture", absolute: (url: string) => `https://example.test${url}` }

// The three parameter trees in v1000.0.0's docs.json, reduced to the surrounding structure the site reads
function fixture() {
    const entries: Entry[] = [{
        key: "js-ts", title: "Fixture", importPath: "fixture", url: "/docs/api/js-ts/", doc: {}, uncategorized: [],
        categories: [{ title: "Messages", slug: "messages", url: "/docs/api/js-ts/messages/", top: [], items: [{
            kind: "class", name: "MessageBuilder", anchor: "messagebuilder", url: "/docs/api/js-ts/messagebuilder/",
            members: Object.entries(elements).map(([name, element]) => ({
                kind: "method", name,
                signatures: [{ p: [{ n: "values", r: 1, t: { k: "op", op: "readonly", t: { k: "tuple", t: [element, element] } } }], r: "unknown" }],
            })),
        }] }],
    }]
    return { entries }
}

const fileOf = (model: { entries: Entry[] }) => ({ path: "reference/model.json", content: JSON.stringify(model) })
const membersOf = (model: { entries: Entry[] }) => {
    const item = model.entries[0]!.categories[0]!.items[0]!
    assert.ok(item.kind === "class")
    return item.members!
}

test("Stable snapshot signatures pass the text checks and render as readonly variadic tuples", () => {
    const original = fixture()
    const file = fileOf(original)
    assert.equal(referenceTextProblems(original.entries).length, 3)
    const model = JSON.parse(snapshotContent(stable, file)) as { entries: Entry[] }
    assert.deepEqual(referenceTextProblems(model.entries), [])
    assert.doesNotThrow(() => checkedText(tasksMarkdown(model.entries, context), referenceTextProblems(model.entries)))
    const text = checkedText(referenceText(model.entries, context), referenceTextProblems(model.entries))
    for (const member of membersOf(model)) {
        const parameter = member.signatures![0]!.p[0]!
        const element = elements[member.name]!
        assert.deepEqual(parameter.t, { k: "op", op: "readonly", t: { k: "tuple", t: [
            { k: "named", n: "first", t: element },
            { k: "rest", t: { k: "named", n: "rest", t: { k: "arr", t: element } } },
        ] } })
        assert.match(typeHtml(parameter.t), /readonly/)
        assert.match(text, new RegExp(`${member.name}\\(\\.\\.\\.values: readonly \\[first:`))
    }
    assert.equal(file.content, JSON.stringify(original), "The snapshot asset stays unchanged")
    assert.equal(snapshotContent(stable, { ...file, path: "guides/index.md" }), file.content)
    assert.equal(snapshotContent(stable, { ...file, content: JSON.stringify(model) }), JSON.stringify(model), "Already repaired signatures stay unchanged")
})

test("The compatibility repair does not hide current or unrelated fixed-length rest parameters", () => {
    const file = fileOf(fixture())
    for (const source of [
        { ...stable, version: "1001.0.0-nightly.20261104.55" },
        { ...stable, sourceCommit: "2d90eb949168396c9cb928be99f95791a244b9d4" },
    ]) {
        assert.equal(snapshotContent(source, file), file.content)
        const model = JSON.parse(snapshotContent(source, file)) as { entries: Entry[] }
        assert.throws(() => checkedText(referenceText(model.entries, context), referenceTextProblems(model.entries)), /fixed-length type/)
    }
    for (const change of [
        (model: { entries: Entry[] }) => { model.entries[0]!.key = "effect" },
        (model: { entries: Entry[] }) => { model.entries[0]!.categories[0]!.items[0]!.name = "OtherBuilder" },
        (model: { entries: Entry[] }) => { for (const member of membersOf(model)) member.name = "otherMethod" },
        (model: { entries: Entry[] }) => { for (const member of membersOf(model)) member.signatures![0]!.p[0]!.t = { k: "op", op: "readonly", t: { k: "tuple", t: ["number", "number"] } } },
    ]) {
        const model = fixture()
        change(model)
        const unrelated = fileOf(model)
        assert.deepEqual(JSON.parse(snapshotContent(stable, unrelated)), model)
        assert.equal(referenceTextProblems(model.entries).length, 3)
    }
})
