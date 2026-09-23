import { test, expect } from "@playwright/test"

test("Release channels preserve Stable history and select rolling prerelease pages", async ({ page }) => {
    await page.goto("/")
    await expect(page).toHaveURL(/\/docs\/latest\/$/)
    await expect(page.locator(".version-label")).toHaveText("SDK 1000.0.1")
    await page.goto("/docs/1000.0.0/api/signature/")
    await expect(page.locator(".docs-content")).toContainText("sendOnce(): Promise<void>")
    await expect(page.locator(".docs-content")).toContainText("Stableonlymarker")
    await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
    const exactTree = JSON.stringify(JSON.parse((await page.locator('astro-island[component-export="Docs"]').getAttribute("props"))!).tree)
    expect(exactTree).toContain("/docs/1000.0.0/api/signature")
    expect(exactTree).toContain("/docs/1000.0.0/api/removed")
    expect(exactTree).not.toContain("/docs/latest/")
    expect(exactTree).not.toContain("/docs/1000.0.1/")
    await page.getByRole("button", { name: "Stable", exact: true }).click()
    await page
        .getByRole("dialog")
        .getByRole("link", { name: "Stable", exact: true })
        .click()
    await expect(page).toHaveURL(/\/docs\/1000\.0\.1\/api\/signature\/?$/)
    await expect(page.locator(".docs-content")).toContainText("sendOnce(): Promise<boolean>")
    await expect(page.locator(".docs-content")).toContainText("Lateststablemarker")
    await page.getByRole("button", { name: "Stable", exact: true }).click()
    await page
        .getByRole("dialog")
        .getByRole("link", { name: "RC", exact: true })
        .click()
    await expect(page).toHaveURL(/\/docs\/rc\/api\/signature\/?$/)
    await expect(page.locator(".docs-content")).toContainText("sendOnce(): Promise<string>")
    await expect(page.locator(".version-label")).toHaveText("SDK 1000.1.0-rc.1")
    await page.goto("/docs/1000.0.0/api/removed/")
    await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
    await page.getByRole("button", { name: "Stable", exact: true }).click()
    await page
        .getByRole("dialog")
        .getByRole("link", { name: "RC", exact: true })
        .click()
    await expect(page).toHaveURL(/\/docs\/rc\/?$/)
})

test("Latest aliases the newest stable release across navigation and search", async ({ page, request }) => {
    const errors: string[] = []
    const indexes: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("response", (response) => {
        if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
    })
    page.on("request", (request) => {
        if (request.url().includes("/api/search/")) indexes.push(new URL(request.url()).pathname)
    })

    await page.goto("/docs/latest/")
    await expect(page).toHaveURL(/\/docs\/latest\/$/)
    await expect(page.locator(".version-label")).toHaveText("SDK 1000.0.1")
    await expect(page.locator(".docs-content")).toContainText("Immutable 1000.0.1 fixture")
    for (const oldLocalPath of ["/docs/dev/quick-start/", "/docs/preview/quick-start/"]) {
        const response = await request.get(oldLocalPath, { maxRedirects: 0 })
        expect(response.status()).toBe(302)
        expect(response.headers().location).toBe("/docs/latest/quick-start/")
    }
    await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
    const tree = JSON.stringify(JSON.parse((await page.locator('astro-island[component-export="Docs"]').getAttribute("props"))!).tree)
    expect(tree).toContain("/docs/latest/api/signature")
    for (const version of ["1000.0.0", "1000.0.1", "1000.1.0-rc.0", "1000.2.0-canary.0", "1000.2.0-canary.1"])
        expect(tree).not.toContain(`/docs/${version}/`)

    await page.getByRole("link", { name: "API reference", exact: true }).first().click()
    await expect(page).toHaveURL(/\/docs\/latest\/api\/?$/)
    await page.getByRole("link", { name: "Versioned signature", exact: true }).first().click()
    await expect(page).toHaveURL(/\/docs\/latest\/api\/signature\/?$/)
    await expect(page.locator(".docs-content")).toContainText("Lateststablemarker")

    await page.getByRole("button", { name: "Stable", exact: true }).click()
    await expect(page.getByRole("dialog").getByRole("link", { name: "Stable", exact: true }))
        .toHaveAttribute("href", "/docs/latest/api/signature")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Control+k")
    const input = page.getByRole("textbox", { name: /Search .* documentation/ })
    await input.fill("Lateststablemarker")
    const result = page.getByRole("dialog").getByRole("button", { name: /Lateststablemarker/ })
    await expect(result).toBeVisible()
    for (const marker of ["Stableonlymarker", "Rconlymarker", "Canaryonlymarker", "Latestcanarymarker"]) {
        await input.fill(marker)
        await expect(page.getByRole("dialog").getByText("No results found")).toBeVisible()
    }
    await input.fill("Lateststablemarker")
    await result.click()
    await expect(page).toHaveURL(/\/docs\/latest\/api\/signature\/?$/)
    const searchIndex = JSON.stringify(await (await request.get("/api/search/latest.json")).json())
    expect(searchIndex).toContain("/docs/latest/api/signature")
    for (const version of ["1000.0.0", "1000.0.1", "1000.1.0-rc.0", "1000.2.0-canary.1"])
        expect(searchIndex).not.toContain(`/docs/${version}/`)
    expect(new Set(indexes)).toEqual(new Set(["/api/search/latest.json"]))
    expect(errors).toEqual([])
})

test("Version search never returns another release or unpublished index", async ({ page }) => {
    const indexes: string[] = []
    page.on("request", (request) => {
        if (request.url().includes("/api/search/")) indexes.push(new URL(request.url()).pathname)
    })
    await page.goto("/docs/rc/")
    await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
    await page.keyboard.press("Control+k")
    const input = page.getByRole("textbox", { name: "Search RC documentation" })
    await input.fill("Rconlymarker")
    await expect(page.getByRole("dialog").getByRole("button", { name: /Rconlymarker/ })).toBeVisible()
    await input.fill("Stableonlymarker")
    await expect(page.getByRole("dialog").getByText("No results found")).toBeVisible()
    await input.fill("Canaryonlymarker")
    await expect(page.getByRole("dialog").getByText("No results found")).toBeVisible()
    await input.fill("Previousrcmarker")
    await expect(page.getByRole("dialog").getByText("No results found")).toBeVisible()
    await input.fill("Rconlymarker")
    await page.getByRole("dialog").getByRole("button", { name: /Rconlymarker/ }).click()
    await expect(page).toHaveURL(/\/docs\/rc\/api\/signature\/?#sendonce$/)
    expect(new Set(indexes)).toEqual(new Set(["/api/search/rc.json"]))
})

test("Only channel labels appear and Canary opens the newest published snapshot", async ({ page }) => {
    for (const path of ["/docs/canary/api/signature/", "/docs/1000.0.0/quick-start/"]) {
        await page.goto(path)
        await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
        await page.getByRole("button", { name: path.includes("signature") ? "Canary" : "Stable", exact: true }).click()
        await expect(page.getByRole("dialog").getByRole("link")).toHaveText(["Stable", "RC", "Canary"])
        await page.getByRole("dialog").getByRole("link", { name: "Canary", exact: true }).click()
        await expect(page).toHaveURL(path.includes("signature")
            ? /\/docs\/canary\/api\/signature\/?$/
            : /\/docs\/canary\/quick-start\/?$/)
        await expect(page.locator(".version-label")).toHaveText("SDK 1000.2.0-canary.1")
    }
})

test("Command preferences persist across exact releases without retaining the previous version", async ({ page }) => {
    await page.goto("/docs/1000.0.0/quick-start/")
    const block = page.locator("[data-command-block]")
    await expect(block.getByLabel("Package manager", { exact: true })).toBeEnabled()
    await block.getByLabel("Package manager", { exact: true }).selectOption("pnpm")
    await expect(block.locator("[data-command-code]")).toHaveText("pnpm add @neontechspace/fluxerly@1000.0.0")
    await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
    await page.getByRole("button", { name: "Stable", exact: true }).click()
    await page.getByRole("dialog").getByRole("link", { name: "RC", exact: true }).click()
    await expect(page).toHaveURL(/\/docs\/rc\/quick-start\/?$/)
    await expect(block.getByLabel("Package manager", { exact: true })).toHaveValue("pnpm")
    await expect(block.locator("[data-command-code]")).toHaveText("pnpm add @neontechspace/fluxerly@1000.1.0-rc.1")
    await block.getByLabel("Package manager", { exact: true }).selectOption("npm")
    await expect(block.locator("[data-command-code]")).toHaveText("npm install @neontechspace/fluxerly@1000.1.0-rc.1")
})

test("Numbered prerelease pages and search indexes return 404 without redirects", async ({ request }) => {
    for (const version of ["1000.1.0-rc.0", "1000.1.0-rc.1", "1000.2.0-canary.0", "1000.2.0-canary.1"]) {
        for (const path of [`/docs/${version}/`, `/docs/${version}/api/signature/?from=link`,
            `/docs/${version}/api/removed/`, `/api/search/${version}.json`]) {
            const response = await request.get(path, { maxRedirects: 0 })
            expect(response.status(), path).toBe(404)
            expect(response.headers().location, path).toBeUndefined()
        }
    }
})

test("Canary navigation, search and serialized tree stay within the rolling channel", async ({ page, request }) => {
    await page.goto("/docs/canary/api/")
    await page.locator(".docs-content").getByRole("link", { name: "Signature", exact: true }).click()
    await expect(page).toHaveURL(/\/docs\/canary\/api\/signature\/?$/)
    await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
    const tree = JSON.stringify(JSON.parse((await page.locator('astro-island[component-export="Docs"]').getAttribute("props"))!).tree)
    expect(tree).toContain("/docs/canary/api/signature")
    for (const path of ["1000.0.0", "1000.0.1", "1000.2.0-canary.0", "1000.2.0-canary.1", "rc", "latest"])
        expect(tree).not.toContain(`/docs/${path}/`)
    const searchIndex = JSON.stringify(await (await request.get("/api/search/canary.json")).json())
    expect(searchIndex).toContain("Latestcanarymarker")
    expect(searchIndex).not.toContain("Canaryonlymarker")
    expect(searchIndex).toContain("/docs/canary/api/signature")
    expect(searchIndex).not.toContain("/docs/1000.2.0-canary.1/")
    await page.keyboard.press("Control+k")
    const input = page.getByRole("textbox", { name: "Search Canary documentation" })
    await input.fill("Latestcanarymarker")
    await page.getByRole("dialog").getByRole("button", { name: /Latestcanarymarker/ }).click()
    await expect(page).toHaveURL(/\/docs\/canary\/api\/signature\/?$/)
})
