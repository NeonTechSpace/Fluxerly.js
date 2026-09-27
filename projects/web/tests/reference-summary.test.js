import assert from "node:assert/strict"
import test from "node:test"
import { referenceSearchEntries } from "../scripts/reference-summary.js"
import { referenceEntries } from "../scripts/reference-entries.js"

const entryPage = `---
title: Entry
---

Entry point summary

## Functions

<a id="createtestclient"></a>

### createTestClient()

> **createTestClient**(): TestClient

Create a test client
`

test("Every entry point page contributes one search result per grouped symbol", () => {
    for (const { name, title } of referenceEntries) {
        const url = `/docs/preview/api/modules/${name}`
        const entries = referenceSearchEntries(entryPage, { title, url })
        assert.deepEqual(entries.map((entry) => entry.url), [url, `${url}#createtestclient`], title)
    }
})

test("A released entry point page keeps per-symbol results under the title it was generated with", () => {
    const url = "/docs/rc/api/modules/Effect"
    const entries = referenceSearchEntries(entryPage, { title: "Effect", url })
    assert.deepEqual(entries.map((entry) => entry.url), [url, `${url}#createtestclient`])
})

test("Symbol pages stay one search result with member headings", () => {
    const url = "/docs/preview/api/interfaces/testing.TestClient"
    const entries = referenceSearchEntries(entryPage, { title: "TestClient", url })
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0].structuredData.headings.map((heading) => heading.id), ["createtestclient"])
})
