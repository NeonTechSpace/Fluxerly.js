import { request } from "node:http"
import { expect, test, vi } from "vitest"
import { startRestServer } from "../support/rest-server.js"

// Attachment tests cancel uploads mid-body, so the shared REST fixture must record the cut-off request instead of
// failing the run with an unhandled connection reset
test("the loopback REST fixture records an aborted upload without calling its route or throwing", async () => {
    const handler = vi.fn()
    const rest = await startRestServer({ routes: { "POST /upload": handler } })
    // The fixture must be reading the body before the connection is cut
    const received = new Promise<void>((resolve) => rest.server.once("request", () => resolve()))
    const upload = request(`${rest.origin}/upload`, { method: "POST", headers: { "content-length": "1000" } })
    // The client side reports its own reset, which is expected here
    upload.on("error", () => undefined)
    upload.write("partial")
    await received
    upload.destroy()
    await vi.waitFor(() => expect(rest.requests).toHaveLength(1))
    expect(rest.requests[0]).toMatchObject({ method: "POST", path: "/upload", aborted: true, body: undefined })
    expect(handler).not.toHaveBeenCalled()
})
