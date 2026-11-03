import assert from "node:assert/strict"
import { test } from "node:test"
import { leadParagraphs, shortParagraphs } from "../src/lib/paragraphs.ts"

const sentence = (word: string, count = 20) => `${word[0]!.toUpperCase()}${word.slice(1)} ${`${word} `.repeat(count - 2)}end`

test("the lead parts a paragraph after its first sentence and leaves out the last period", () => {
    assert.equal(leadParagraphs("First one. Then `a.b` e.g. this. Last one."), "First one\n\nThen `a.b` e.g. this. Last one")
    assert.equal(leadParagraphs("Only one."), "Only one")
    assert.equal(leadParagraphs("First.\n\nSecond."), "First.\n\nSecond.")
})

test("the lead's further sentences are parted like any long paragraph", () => {
    const rest = "abcdefgh".split("").map((letter) => sentence(letter)).join(". ")
    const paragraphs = leadParagraphs(`First one. ${rest}.`)!.split("\n\n")
    assert.equal(paragraphs[0], "First one")
    assert.ok(paragraphs.length > 2)
})

test("a long paragraph is parted at its sentence ends, every word kept", () => {
    const wall = "abcdefgh".split("").map((letter) => sentence(letter)).join(". ") + "."
    const parted = shortParagraphs(wall)!
    const paragraphs = parted.split("\n\n")
    assert.ok(paragraphs.length > 1)
    assert.ok(paragraphs.every((paragraph) => paragraph.split(/\s+/).length <= 55 && !paragraph.endsWith(".")))
    assert.deepEqual(parted.replaceAll("\n\n", ". ").split(/[\s.]+/).filter(Boolean), wall.split(/[\s.]+/).filter(Boolean))
})

test("a period inside code or a link does not end a sentence", () => {
    const wall = `${sentence("a", 79)} \`client.Shutdown\` [Docs. Here](/docs/a.b/) more. ${sentence("b", 30)}`
    const parted = shortParagraphs(wall)!
    assert.deepEqual(parted.split("\n\n").length, 2)
    assert.ok(parted.split("\n\n")[0]!.endsWith("more"))
})

test("short paragraphs, lists and code stay as they are", () => {
    const list = `- ${sentence("a", 50)}. ${sentence("b", 50)}`
    const code = `\`\`\`js\n${"const a = 1. Bb\n".repeat(50)}\n\nconst b = 2. Bb ${"c ".repeat(90)}\n\`\`\``
    for (const text of ["Short. Text.", list, code]) assert.equal(shortParagraphs(text), text)
})
