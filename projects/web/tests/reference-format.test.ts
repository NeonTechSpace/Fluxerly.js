// Tests that printed reference types keep the parentheses TypeScript needs, on the generated model's CommandRequirements
// and on small fixtures
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"
import type { Entry, Type } from "../src/lib/reference.ts"
import { declarationHtml, typeHtml } from "../src/lib/reference-format.ts"

const plain = (html: string) =>
    html
        .replace(/<[^>]+>/g, "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&")

const parseErrors = (source: string) =>
    (ts.createSourceFile("printed.ts", source, ts.ScriptTarget.Latest) as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    )

test("the printed CommandRequirements declaration is valid TypeScript", () => {
    const model = JSON.parse(readFileSync(new URL("../content/reference/model.json", import.meta.url), "utf8")) as { entries: Entry[] }
    const found: { name: string; type?: Type; tp?: Parameters<typeof declarationHtml>[2]["tp"] }[] = []
    const walk = (value: unknown) => {
        if (!value || typeof value !== "object") return
        const record = value as Record<string, unknown>
        if (record.name === "CommandRequirements" && record.kind === "type") found.push(record as (typeof found)[number])
        for (const inner of Object.values(record)) walk(inner)
    }
    walk(model.entries)
    assert.ok(found.length > 0, "The model has a CommandRequirements type")
    for (const declaration of found) {
        const printed = plain(declarationHtml("type", declaration.name, { type: declaration.type, tp: declaration.tp }))
        assert.match(printed, /readonly \(infer Each\)\[\]/)
        assert.deepEqual(parseErrors(printed), [])
    }
})

test("an inferred type or a type operator before [] keeps its parentheses, and a type query needs none", () => {
    assert.equal(plain(typeHtml({ k: "op", op: "readonly", t: { k: "arr", t: { k: "infer", n: "Each" } } } as Type)), "readonly (infer Each)[]")
    assert.equal(plain(typeHtml({ k: "arr", t: { k: "op", op: "keyof", t: "Shape" } } as Type)), "(keyof Shape)[]")
    assert.equal(plain(typeHtml({ k: "op", op: "keyof", t: { k: "arr", t: "Shape" } } as Type)), "keyof Shape[]")
    assert.equal(plain(typeHtml({ k: "op", op: "keyof", t: { k: "query", t: "shape" } } as Type)), "keyof typeof shape")
    assert.equal(plain(typeHtml({ k: "arr", t: { k: "query", t: "shape" } } as Type)), "typeof shape[]")
})
