import assert from "node:assert/strict"
import { withHostedDiscovery } from "../hosted-discovery.mjs"
import { sendOnce } from "./out/consumer-guide.js"

let requests = 0
let fail = false
globalThis.fetch = withHostedDiscovery(async (url, options) => {
    assert.equal(url, "https://api.fluxer.app/v1/channels/20/messages")
    assert.equal(options.method, "POST")
    assert.equal(new Headers(options.headers).get("authorization"), "Bot fixture-only")
    assert.equal(JSON.parse(options.body).content, "guide fixture")
    requests += 1
    return fail
        ? Response.json({ message: "Forbidden", code: 50013 }, { status: 403 })
        : Response.json({
              id: "40",
              channel_id: "20",
              content: "guide fixture",
              author: { id: "30", username: "fixture" },
          })
})

assert.equal(await sendOnce("fixture-only", "20", "guide fixture"), "40")
assert.equal(requests, 1)
fail = true
await assert.rejects(() => sendOnce("fixture-only", "20", "guide fixture"))
assert.equal(requests, 2, "Expected failures must not cause a second write")
console.log("Packed consumer guide example passed success and expected failure")
