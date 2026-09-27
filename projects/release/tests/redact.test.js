import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import test from "node:test"
import { forwardRedacted, redact } from "../redact.js"

test("Provider output keeps diagnostics while token-like and secret variable values are removed", () => {
    const secrets = [
        `npm_${"a".repeat(36)}`,
        `ghs_${"b".repeat(36)}`,
        `github_pat_${"c".repeat(40)}`,
        "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvIn0.c2lnbmF0dXJlLXZhbHVl",
        "private-environment-value",
    ]
    const text = [
        `npm error 403 Forbidden using ${secrets[0]}`,
        `gh token ${secrets[1]} and ${secrets[2]}`,
        `oidc ${secrets[3]}`,
        "Authorization: Bearer abc.def",
        "//registry.npmjs.org/:_authToken=secret-value",
        `configured ${secrets[4]}`,
    ].join("\n")
    const output = redact(text, { GH_TOKEN: secrets[4] })
    for (const secret of [...secrets, "abc.def", "secret-value"]) assert.ok(!output.includes(secret), secret)
    assert.match(output, /npm error 403 Forbidden/)
    assert.match(output, /Authorization: Bearer \[redacted\]/)
})

test("Forwarded streams are redacted per line even when a token spans chunks", async () => {
    const source = new PassThrough()
    let written = ""
    forwardRedacted(source, { write: (text) => (written += text) }, {})
    source.write(`publishing with npm_${"a".repeat(20)}`)
    source.write(`${"a".repeat(16)} done\nlast line`)
    source.end()
    await new Promise((resolve) => source.once("end", resolve))
    assert.equal(written, "publishing with [redacted] done\nlast line\n")
})
