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

for (const width of [390, 1440]) {
    test(`Latest keeps ordinary documentation navigation clear at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        page.on("response", (response) => {
            if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
        })

        await page.goto("/docs/latest/quick-start/")
        await expect(page).toHaveURL(/\/docs\/latest\/quick-start\/?$/)
        await expect(page.locator(".version-label")).toHaveText("Canary · Unreleased")
        await expect(page.getByRole("heading", { level: 1, name: "Start your first bot" })).toBeVisible()
        await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")

        const sidebar = page.locator(width < 768 ? "#nd-sidebar-mobile" : "#nd-sidebar")
        if (width < 768) {
            await page.getByRole("button", { name: "Open Sidebar", exact: true }).click()
            await expect(sidebar).toHaveAttribute("data-state", "open")
        }
        await expect(sidebar.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute(
            "href",
            "/docs/latest",
        )
        const apiLink = sidebar.getByRole("link", { name: "API reference", exact: true })
        await expect(apiLink).toHaveAttribute("href", "/docs/latest/api")
        await page.screenshot({
            path: info.outputPath(width < 768 ? "latest-mobile-navigation.png" : "latest-desktop-navigation.png"),
            fullPage: true,
            animations: "disabled",
        })
        await apiLink.click()
        await expect(page).toHaveURL(/\/docs\/latest\/api\/?$/)
        await expect(page.getByRole("heading", { level: 1, name: "API reference" })).toBeVisible()

        await page.goto("/docs/latest/api/interfaces/js-ts.Client/")
        await expect(page).toHaveURL(/\/docs\/latest\/api\/interfaces\/js-ts\.Client\/?$/)
        await expect(page.getByRole("heading", { level: 1, name: "Client" })).toBeVisible()
        expect(errors).toEqual([])
    })
}

test("Latest reference previews and their destination stay on the alias", async ({ page }) => {
    const routerPath = "/docs/latest/api/interfaces/Effect.NativePrefixCommandRouter/"
    const commandPath = "/docs/latest/api/interfaces/Effect.NativePrefixCommand/"
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("response", (response) => {
        if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
    })

    await page.goto(`${routerPath}#register`)
    const typeLink = page
        .locator(".docs-content")
        .getByRole("link", { name: "NativePrefixCommand", exact: true })
        .first()
    await typeLink.hover()
    const preview = page.getByRole("dialog", { name: "NativePrefixCommand type preview", exact: true })
    await expect(preview).toBeVisible()
    await expect(preview.locator(".reference-preview-description")).not.toBeEmpty()
    const open = preview.getByRole("link", { name: "Open type", exact: true })
    await expect(open).toHaveAttribute("href", new URL(commandPath, page.url()).href)
    await open.click()
    await expect(page).toHaveURL(new RegExp(`${commandPath}$`))
    await expect(page.getByRole("heading", { level: 1, name: "NativePrefixCommand", exact: true })).toBeVisible()
    expect(errors).toEqual([])
})

test("Latest renders useful documentation without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    try {
        const page = await context.newPage()
        await page.goto("/docs/latest/quick-start/")
        await expect(page).toHaveURL(/\/docs\/latest\/quick-start\/?$/)
        await expect(page.locator(".version-label")).toHaveText("Canary · Unreleased")
        await expect(page.getByRole("heading", { level: 1, name: "Start your first bot" })).toBeVisible()
        await expect(page.locator("[data-command-code]").first()).toContainText("npm install")
    } finally {
        await context.close()
    }
})

test("Latest routing redirects only documentation page requests", async ({ request }) => {
    await expectRedirect(request, "/", "/docs/latest/")
    await expectRedirect(request, "/docs", "/docs/latest/")
    await expectRedirect(request, "/docs/quick-start/", "/docs/latest/quick-start/")
    await expectRedirect(request, "/docs/999.0.0/quick-start/", "/docs/latest/quick-start/")
    await expectRedirect(
        request,
        "/docs/999.0.0/api/interfaces/js-ts.Client/",
        "/docs/latest/api/interfaces/js-ts.Client/",
    )
    await expectRedirect(request, "/docs/999.0.0/page-that-does-not-exist/", "/docs/latest/")
    await expectRedirect(request, "/docs/latest/not-found/", "/docs/latest/")
    await expectRedirect(request, "/docs/%E0%A4%A/quick-start/", "/docs/latest/")

    const recovered = await request.get("/docs/latest/not-found/")
    expect(recovered.status()).toBe(200)
    expect(new URL(recovered.url()).pathname).toBe("/docs/latest/")

    await expectNoFallback(await request.get("/docs/latest/not-found.js", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/docs/latest/not-found.css", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/docs/latest/search/not-found", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/_astro/not-found.js", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/scripts/not-found.js", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/api/search/missing.json", { maxRedirects: 0 }))
    await expectNoFallback(await request.get("/unrelated/not-found", { maxRedirects: 0 }))
    await expectNoFallback(await request.post("/docs/999.0.0/quick-start/", { maxRedirects: 0 }))

    const reference = await request.get("/docs/latest/api/interfaces/js-ts.Client/", { maxRedirects: 0 })
    expect(reference.status()).toBe(200)
    expect(reference.headers()["x-robots-tag"]).toBe("noindex, nofollow")
})

test("Recovery preserves query and fragment without client-side redirection", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    try {
        const page = await context.newPage()
        const response = await page.goto("/docs/missing/quick-start/?ref=shared#keep-going")
        expect(response?.status()).toBe(200)
        await expect(page).toHaveURL(/\/docs\/latest\/quick-start\/\?ref=shared#keep-going$/)
    } finally { await context.close() }
})
