import assert from "node:assert/strict"
import { get } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { serveSite } from "../scripts/checks/lib.mjs"

// The browser checks serve the built site on a local port. A request must never reach a file outside the site, and a
// malformed address must not stop the server

// A handler that throws never answers, so an error escaping the server fails the request instead of leaving it waiting
let serverError
const escaped = new Promise((_, fail) => (serverError = fail))
escaped.catch(() => {})
process.on("unhandledRejection", (error) => serverError(error))

function request(url, path) {
    const { hostname, port } = new URL(url)
    let sent
    const answer = new Promise((done, fail) => {
        sent = get({ hostname, port, path }, (response) => {
            const chunks = []
            response.on("data", (chunk) => chunks.push(chunk))
            response.on("end", () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
        }).on("error", fail)
    })
    // The unanswered connection would otherwise keep the server from closing
    return Promise.race([answer, escaped]).catch((error) => {
        sent.destroy()
        throw error
    })
}

test("the check server keeps requests inside the site and survives malformed addresses", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "fluxerly-check-server-"))
    t.after(() => rm(base, { recursive: true, force: true }))
    const root = join(base, "site")
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "index.html"), "home")
    await writeFile(join(root, "404.html"), "missing")
    await writeFile(join(root, "docs", "index.html"), "docs")
    await writeFile(join(base, "outside.txt"), "outside-secret")
    await writeFile(join(base, "site-outside.txt"), "outside-secret")
    const site = await serveSite(root)
    t.after(() => site.close())

    const escapes = [
        "/..%2foutside.txt",
        "/..%2Foutside.txt",
        "/%2e%2e%2foutside.txt",
        "/.%2e/outside.txt",
        "/docs/..%2f..%2foutside.txt",
        "/..%2fsite-outside.txt",
        "/%2e%2e%5coutside.txt",
        "/..%252foutside.txt",
        `/..%2f..%2f${encodeURIComponent(base.slice(1))}%2foutside.txt`,
    ]
    for (const path of escapes) {
        const answer = await request(site.url, path)
        assert.notEqual(answer.status, 200, path)
        assert.doesNotMatch(answer.body, /outside-secret/, path)
    }

    for (const path of ["/%", "/%E0%A4%A", "/docs/%zz"]) {
        assert.equal((await request(site.url, path)).status, 400, path)
    }

    assert.deepEqual(await request(site.url, "/"), { status: 200, body: "home" })
    assert.deepEqual(await request(site.url, "/docs/"), { status: 200, body: "docs" })
    assert.deepEqual(await request(site.url, "/missing"), { status: 404, body: "missing" })
})
