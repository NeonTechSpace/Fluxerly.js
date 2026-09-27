import { test, expect, type APIRequestContext, type APIResponse } from "@playwright/test"

const pathname = (response: APIResponse) =>
    new URL(response.headers().location, "http://127.0.0.1:4322").pathname

async function expectRedirect(request: APIRequestContext, from: string, to: string) {
    const response = await request.get(from, { maxRedirects: 0 })
    expect(response.status(), from).toBe(302)
    expect(pathname(response), from).toBe(to)
}

async function expectNoFallback(response: APIResponse) {
    expect(response.status()).toBeGreaterThanOrEqual(400)
    expect(response.status()).toBeLessThan(500)
    expect(response.headers().location).toBeUndefined()
}

test("Local routing redirects only documentation page requests", async ({ request }) => {
    await expectRedirect(request, "/", "/docs/preview/")
    await expectRedirect(request, "/docs", "/docs/preview/")
    await expectRedirect(request, "/docs/quick-start/", "/docs/preview/quick-start/")
    await expectRedirect(request, "/docs/999.0.0/quick-start/", "/docs/preview/quick-start/")
    await expectRedirect(
        request,
        "/docs/999.0.0/api/interfaces/js-ts.Client/",
        "/docs/preview/api/interfaces/js-ts.Client/",
    )
    await expectRedirect(request, "/docs/999.0.0/page-that-does-not-exist/", "/docs/preview/")
    await expectRedirect(request, "/docs/preview/not-found/", "/docs/preview/")
    await expectRedirect(request, "/docs/%E0%A4%A/quick-start/", "/docs/preview/")

    const recovered = await request.get("/docs/preview/not-found/")
    expect(recovered.status()).toBe(200)
    expect(new URL(recovered.url()).pathname).toBe("/docs/preview/")

    await expectNoFallback(await request.get("/docs/preview/not-found.js", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/docs/preview/not-found.css", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/docs/preview/search/not-found", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/_astro/not-found.js", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/scripts/not-found.js", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/api/search/missing.json", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/unrelated/not-found", { maxRedirects: 0 }))
    await expectNoFallback(await request.post("/docs/999.0.0/quick-start/", { maxRedirects: 0 }))

    const reference = await request.get("/docs/preview/api/interfaces/js-ts.Client/", { maxRedirects: 0 })
    expect(reference.status()).toBe(200)
    expect(reference.headers()["x-robots-tag"]).toBe("noindex, nofollow")
})

test("Recovery preserves query and fragment without client-side redirection", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    try {
        const page = await context.newPage()
        const response = await page.goto("/docs/missing/quick-start/?ref=shared#keep-going")
        expect(response?.status()).toBe(200)
        await expect(page).toHaveURL(/\/docs\/preview\/quick-start\/\?ref=shared#keep-going$/)
    } finally { await context.close() }
})
