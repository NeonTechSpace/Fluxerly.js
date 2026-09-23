import { test, expect } from "@playwright/test"
import { existsSync, readFileSync } from "node:fs"
import AxeBuilder from "@axe-core/playwright"

const guidesDirectory = new URL("../../content/guides/", import.meta.url)
const { previewVersion } = JSON.parse(readFileSync(new URL("../../content/versions.json", import.meta.url), "utf8")) as { previewVersion: string | null }
const previewLabel = previewVersion ? `Planned ${previewVersion} · Unreleased source preview` : "Unreleased source preview"
const guideInventory = JSON.parse(readFileSync(new URL("meta.json", guidesDirectory), "utf8")) as { pages: string[] }
const frontmatter = (source: string, name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(source)?.[1].trim()
const authoredGuides = guideInventory.pages.flatMap((slug) => {
    const file = new URL(`${slug}.md`, guidesDirectory)
    if (!existsSync(file)) return []
    const source = readFileSync(file, "utf8")
    const title = frontmatter(source, "title")
    if (!title) throw new Error(`Guide ${slug} has no title`)
    return [{
        slug,
        title,
        navTitle: frontmatter(source, "navTitle"),
        examples: slug === "quick-start" ? 3 : source.split(/\r?\n/).filter((line) => /^```\S+$/.test(line)).length,
    }]
})

const navigationGroups = ["Getting started", "Bot guides", "Operations", "Effect", "Reference"]
const quickStartTitle = authoredGuides.find((guide) => guide.slug === "quick-start")!.title

for (const width of [390, 1440, 1920]) {
    test(`Readable guide and reference at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        page.on("response", (response) => {
            if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
        })
        await page.goto("/docs/preview/quick-start/")
        await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
        await page.evaluate(() => document.fonts.ready)
        await expect(page.getByRole("heading", { level: 1, name: quickStartTitle, exact: true })).toBeVisible()
        if (previewVersion) expect(previewVersion).toMatch(/^\d+\.\d+\.\d+(?:-(?:canary|rc)\.\d+)?$/)
        await expect(page.locator(".version-label")).toHaveText(previewLabel)
        const notice = page.getByRole("complementary", { name: "Important preview notice" })
        await expect(notice.locator("strong")).toHaveText("IMPORTANT")
        await expect(notice.locator("span")).not.toBeEmpty()
        const titleBox = await page.locator("h1").boundingBox()
        const noticeBox = await notice.boundingBox()
        const descriptionBox = await page.locator(".description").boundingBox()
        expect(noticeBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height)
        expect(descriptionBox!.y).toBeGreaterThanOrEqual(noticeBox!.y + noticeBox!.height)
        await expect(page.locator("html")).toHaveClass("dark")
        expect(
            await page.locator(".docs-content").evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
        ).toBeGreaterThanOrEqual(20)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (width === 390) {
            const codeBlocks = page.locator(".docs-content pre:visible")
            expect(await codeBlocks.count()).toBeGreaterThan(2)
            expect(await codeBlocks.evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth))).toBe(true)
        }
        await page.screenshot({ path: info.outputPath(`guide-${width}.png`), fullPage: true, animations: "disabled" })
        if (width === 390)
            await page.screenshot({ path: info.outputPath("mobile-reading.png"), animations: "disabled" })
        const accessibility = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze()
        expect(accessibility.violations).toEqual([])
        await page.goto("/docs/preview/api/interfaces/js-ts.Client/#messages")
        await expect(page.getByRole("heading", { level: 1, name: "Client" })).toBeVisible()
        expect(await page.locator("#messages").count()).toBe(1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: info.outputPath(`reference-${width}.png`), fullPage: false })
        await page.goto("/docs/preview/api/modules/js-ts/")
        await expect(page.getByRole("heading", { level: 1, name: "JavaScript & TypeScript", exact: true })).toBeVisible()
        const usage = page.locator("details").filter({ has: page.locator("summary", { hasText: "Usage details" }) })
        await expect(usage).not.toHaveAttribute("open")
        if (width >= 1440) await expect(page.getByRole("link", { name: "Usage details", exact: true })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: info.outputPath(`api-overview-${width}.png`), fullPage: true, animations: "disabled" })
        await page.goto("/docs/preview/api/")
        await expect(page.locator(".docs-content").getByRole("link", { name: "first-bot guide" })).toBeVisible()
        await expect(page.locator(".docs-content").getByRole("heading", { name: "JavaScript & TypeScript", exact: true })).toBeVisible()
        await expect(page.locator(".docs-content").getByRole("link", { name: "js-ts", exact: true })).toHaveCount(0)
        await expect(page.getByRole("link", { name: /AssetUrlError.*Next Page/ })).toHaveCount(0)
        await page.screenshot({ path: info.outputPath(`api-entry-${width}.png`), fullPage: true, animations: "disabled" })
        expect(errors).toEqual([])
    })
}

for (const width of [390, 1440]) {
    test(`Bot lifetime guide remains readable at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto("/docs/preview/starter-lifetime/")
        await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
        await page.evaluate(() => document.fonts.ready)
        await expect(page.getByRole("heading", { level: 1, name: "Run a bot with the SDK" })).toBeVisible()
        await expect(page.locator(".docs-content")).toContainText("runBot")
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (width === 390) {
            // Scan the settled mobile heading, not the outgoing label halfway through its fade
            const label = authoredGuides.find((guide) => guide.slug === "starter-lifetime")!.navTitle!
            await expect(page.locator("[data-toc-popover-trigger]").getByText(label, { exact: true }))
                .toHaveCSS("opacity", "0")
        }
        const accessibility = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze()
        expect(accessibility.violations).toEqual([])
    })
}

test("Search opens by keyboard, finds the current API and returns focus", async ({ page }, info) => {
    await page.goto("/docs/preview/")
    const trigger = page.getByRole("button", { name: "Search Ctrl K", exact: true })
    // Wait for the client-rendered shortcut hint, not only Astro's hydration marker
    await expect(trigger).toBeVisible()
    await page.keyboard.press("Control+k")
    const input = page.getByRole("textbox", { name: "Search source preview documentation" })
    await expect(input).toBeVisible()
    await input.fill("createClient")
    await expect(
        page.getByRole("dialog").getByRole("button", { name: "createClient", exact: true }).first(),
    ).toBeVisible()
    const excerpt = page.locator(".search-excerpt > .min-w-0").first()
    await expect(excerpt).toBeVisible()
    expect(
        await excerpt.evaluate((node) => node.clientHeight / parseFloat(getComputedStyle(node).lineHeight)),
    ).toBeLessThanOrEqual(3.1)
    await page.screenshot({ path: info.outputPath("search.png") })
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/docs\/preview\/api\/functions\/\w+\.createClient\/?$/)
    await page.goBack()
    await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
    await trigger.click()
    await expect(input).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(input).not.toBeVisible()
    await expect(trigger).toBeFocused()
    await page.locator('.docs-content a[href="/docs/preview/quick-start/"]').click()
    await expect(page).toHaveURL(/\/docs\/preview\/quick-start\/?$/)
    await page.goBack()
    await expect(page.getByRole("heading", { name: "Build a Fluxer bot", exact: true })).toBeVisible()
})

test("Dark reading remains usable with enlarged text and reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.setViewportSize({ width: 780, height: 900 })
    await page.goto("/docs/preview/quick-start/")
    await page.addStyleTag({ content: ":root { font-size: 36px !important; }" })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
})

test("API navigation stays compact on a deep symbol without losing reference access", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/docs/preview/api/interfaces/js-ts.Client/#messages")
    await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
    const sidebar = page.locator("#nd-sidebar")
    await expect(sidebar.getByRole("link", { name: "API reference", exact: true })).toBeVisible()
    await expect(sidebar.getByRole("link", { name: "JavaScript & TypeScript", exact: true })).toBeVisible()
    await expect(sidebar.getByRole("link", { name: "Effect-native", exact: true })).toBeVisible()
    const referenceNavigation = sidebar.locator(".reference-nav")
    await expect(referenceNavigation.getByRole("link")).toHaveCount(3)
    await expect(sidebar.getByRole("button", { name: "Interfaces", exact: true })).toHaveCount(0)
    await sidebar.getByRole("link", { name: "JavaScript & TypeScript", exact: true }).click()
    await expect(page.getByRole("heading", { level: 1, name: "JavaScript & TypeScript", exact: true })).toBeVisible()
    await page.locator(".docs-content summary").getByText("Interfaces", { exact: true }).click()
    await expect(page.locator(".docs-content").getByRole("link", { name: "Client", exact: true }).first()).toBeVisible()
    await page.goto("/docs/preview/api/modules/js-ts/#classes")
    await expect(page.locator(".docs-content").getByRole("link", { name: "AssetUrlError", exact: true })).toBeVisible()
})

for (const width of [390, 1440]) {
    test(`Grouped sidebar uses short labels without truncation at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto("/docs/preview/quick-start/")
        const sidebar = page.locator(width < 768 ? "#nd-sidebar-mobile" : "#nd-sidebar")
        if (width < 768) {
            // The server-rendered trigger is focusable before React installs its keyboard action
            await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
            await expect(sidebar).toHaveAttribute("data-state", "closed")
            const trigger = page.getByRole("button", { name: "Open Sidebar", exact: true })
            await trigger.focus()
            await expect(trigger).toBeFocused()
            await page.keyboard.press("Enter")
            await expect(sidebar).toHaveAttribute("data-state", "open")
            await expect(sidebar.getByRole("button", { name: "Close Sidebar", exact: true }))
                .toHaveAttribute("aria-expanded", "true")
        }
        for (const group of navigationGroups) await expect(sidebar.getByText(group, { exact: true })).toBeVisible()
        for (const item of [
            { name: "Overview", href: "/docs/preview" },
            { name: "API reference", href: "/docs/preview/api" },
            { name: "JavaScript & TypeScript", href: "/docs/preview/api/modules/js-ts" },
            { name: "Effect-native", href: "/docs/preview/api/modules/Effect" },
            { name: "Changelog", href: "/docs/preview/changelog" },
        ]) {
            const link = sidebar.getByRole("link", { name: item.name, exact: true })
            await expect(link).toHaveAttribute("href", item.href)
            expect(await link.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
        }
        const navigableGuide = authoredGuides.find((guide) => guide.navTitle && guide.navTitle !== guide.title)
        expect(navigableGuide).toBeDefined()
        for (const guide of authoredGuides) {
            expect(guide.navTitle, `${guide.slug} has a short sidebar label`).toBeTruthy()
            const link = sidebar.getByRole("link", { name: guide.navTitle!, exact: true })
            await expect(link).toHaveAttribute("href", `/docs/preview/${guide.slug}`)
            expect(await link.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
        }
        const selected = sidebar.getByRole("link", { name: navigableGuide!.navTitle!, exact: true })
        await selected.click()
        await expect(page).toHaveURL(new RegExp(`/docs/preview/${navigableGuide!.slug}/?$`))
        await expect(page.getByRole("heading", { level: 1, name: navigableGuide!.title, exact: true })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
}

for (const width of [390, 1440]) {
    test(`Authored guide inventory renders at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        page.on("response", (response) => {
            if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
        })

        expect(authoredGuides.length).toBeGreaterThan(0)
        if (width === 1440) {
            await page.goto("/docs/preview/quick-start/")
            const sidebar = page.locator("#nd-sidebar")
            for (const guide of authoredGuides) {
                expect(guide.navTitle, `${guide.slug} has a short sidebar label`).toBeTruthy()
                await expect(sidebar.getByRole("link", { name: guide.navTitle!, exact: true }))
                    .toHaveAttribute("href", `/docs/preview/${guide.slug}`)
            }
        }

        for (const guide of authoredGuides) {
            await page.goto(`/docs/preview/${guide.slug}/`)
            await expect(page.getByRole("heading", { level: 1, name: guide.title, exact: true })).toBeVisible()
            await expect(page.locator(".docs-content pre:visible"), `Every ${guide.slug} example is visible`)
                .toHaveCount(guide.examples)
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        }
        await page.goto("/docs/preview/messages/")
        await expect(page.locator(".docs-content .prose-keyword").filter({ hasText: "API" }).first()).toBeVisible()
        await expect(page.locator(".docs-content .prose-keyword").filter({ hasText: "SDK" }).first()).toBeVisible()
        await page.goto("/docs/preview/effect-first-bot/")
        for (const keyword of ["Node.js", "ESM", "TypeScript"])
            await expect(page.locator(".docs-content .prose-keyword").filter({ hasText: keyword }).first()).toBeVisible()
        expect(errors).toEqual([])
    })
}

test("Inline command choices synchronize, survive navigation and reload, and copy the displayed command", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto("/docs/preview/quick-start/")
    const blocks = page.locator("[data-command-block]")
    await expect(blocks).toHaveCount(3)
    const manager = blocks.first().getByLabel("Package manager", { exact: true })
    await expect(manager).toBeEnabled()
    await expect(manager).toHaveValue("npm")
    await manager.selectOption("pnpm")
    await expect(blocks.first().locator("[data-command-code]")).toHaveText("node bot.js")
    for (const block of await blocks.all()) {
        await expect(block.getByLabel("Package manager", { exact: true })).toHaveValue("pnpm")
    }
    await blocks.first().getByRole("button", { name: "Copy", exact: true }).click()
    await expect(blocks.first().getByRole("status")).toHaveText("Copied")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("node bot.js")
    await page.getByText("Using TypeScript or Effect?", { exact: true }).click()
    await blocks.last().getByLabel("Package manager", { exact: true }).selectOption("npm")
    await expect(blocks.first().locator("[data-command-code]")).toHaveText("node bot.js")
    await expect(blocks.last().locator("[data-command-code]")).toHaveText("npm list effect")
    await expect(blocks.nth(1).locator("[data-command-code]")).toContainText("npm install --save-exact effect@")
    await blocks.nth(1).getByLabel("Package manager", { exact: true }).selectOption("pnpm")
    await page.locator(".docs-content").getByRole("link", { name: /client.s message methods/ }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Client", exact: true })).toBeVisible()
    await page.goBack()
    await expect(blocks.first().getByLabel("Package manager", { exact: true })).toHaveValue("pnpm")
    await page.reload()
    await expect(blocks.first().getByLabel("Package manager", { exact: true })).toHaveValue("pnpm")
    await page.getByText("Using TypeScript or Effect?", { exact: true }).click()
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()
    expect(accessibility.violations).toEqual([])
    expect(errors).toEqual([])
})

test("Package manager selector remains keyboard usable on mobile and keeps working without storage", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await page.addInitScript(() => {
        Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage blocked", "SecurityError") } })
    })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto("/docs/preview/quick-start/")
    const first = page.locator("[data-command-block]").first()
    const manager = first.getByLabel("Package manager", { exact: true })
    await expect(manager).toBeEnabled()
    await manager.focus()
    await page.keyboard.press("p")
    await page.keyboard.press("Escape")
    await expect(manager).toHaveValue("pnpm")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.locator(".docs-content").getByRole("link", { name: /client.s message methods/ }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Client", exact: true })).toBeVisible()
    await page.goBack()
    await expect(first.getByLabel("Package manager", { exact: true })).toHaveValue("pnpm")
    expect(errors).toEqual([])
})

test("Default commands remain readable without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    try {
        const page = await context.newPage()
        await page.goto("/docs/preview/quick-start/")
        const first = page.locator("[data-command-block]").first()
        await expect(first.locator("[data-command-code]")).toHaveText("node bot.js")
        await expect(first.getByLabel("Package manager", { exact: true })).toBeDisabled()
        await expect(first.getByText("Enable JavaScript to change command preferences")).toBeVisible()
    } finally { await context.close() }
})
