// Tests the guard every offline suite loads, projects/scripts/no-fluxer-network.mjs. It runs in a child process whose real
// fetch is a recorder and whose sockets resolve to this machine, so a broken guard still sends nothing to Fluxer
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const guard = fileURLToPath(new URL("../../scripts/no-fluxer-network.mjs", import.meta.url))
const recorder = `globalThis.fetch = async (url) => { console.log("sent " + url); return new Response("") }`
const local = `(host, options, done) => options?.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4)`

const run = (code) =>
    spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(recorder)}`, "--import", guard, "--input-type=module", "-e", code], { encoding: "utf8" })

test("a request to a Fluxer host fails, and fails the process even when the code under test catches it", () => {
    const result = run(`
        import https from "node:https"
        import net from "node:net"
        const tries = [
            () => fetch("https://docs.fluxer.app/http-api/"),
            () => fetch("https://docs.fluxer.com/http-api/"),
            () => fetch(new Request("https://fluxer.com/api/v1/gateway/bot")),
            () => fetch("https://api.fluxer.app/v1/gateway/bot"),
            () => fetch("https://fluxerusercontent.com/attachments/1/2/a.png"),
            () => fetch("https://fluxerstatic.com/avatars/0.png"),
            () => fetch("https://uploads.fluxer.app/upload"),
            () => new Promise((done, fail) => https.get({ host: "gateway.fluxer.app", port: 1, lookup: ${local} }, done).on("error", fail)),
            () => new Promise((done, fail) => https.get({ host: "gateway.fluxer.com", port: 1, lookup: ${local} }, done).on("error", fail)),
            () => new Promise((done, fail) => net.connect({ host: "fluxer.gg", port: 1, lookup: ${local} }, done).on("error", fail)),
        ]
        for (const attempt of tries) {
            try {
                await attempt()
                console.log("allowed")
            } catch (error) {
                console.log(/must not reach Fluxer/.test(error.message) ? "refused" : "other " + error.code)
            }
        }
    `)
    assert.equal(result.stdout.trim(), Array(10).fill("refused").join("\n"))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /docs\.fluxer\.app/)
})

test("other hosts pass through", () => {
    const result = run(`await fetch("https://raw.githubusercontent.com/x"); await fetch("https://fluxerly.com/"); await fetch("https://notfluxer.app/"); await fetch("https://notfluxer.com/")`)
    assert.equal(result.stdout.trim(), ["sent https://raw.githubusercontent.com/x", "sent https://fluxerly.com/", "sent https://notfluxer.app/", "sent https://notfluxer.com/"].join("\n"))
    assert.equal(result.status, 0, result.stderr)
})
