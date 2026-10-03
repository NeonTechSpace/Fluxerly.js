import { test, expect, type Locator } from "@playwright/test"
import { existsSync, readFileSync } from "node:fs"
import AxeBuilder from "@axe-core/playwright"

const guidesDirectory = new URL("../../content/guides/", import.meta.url)
const { previewVersion } = JSON.parse(readFileSync(new URL("../../content/versions.json", import.meta.url), "utf8")) as { previewVersion: string | null }
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
        examples: slug === "quick-start" ? 4 : source.split(/\r?\n/).filter((line) => /^```\S+$/.test(line)).length,
    }]
})

// Sidebar section labels are the separators of the authored guide inventory
const navigationGroups = guideInventory.pages.flatMap((entry) => /^---(.+)---$/.exec(entry)?.[1] ?? [])
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
        // The label names the planned version and marks the build as a preview, without pinning its wording
        const versionLabel = page.locator(".version-label")
        await expect(versionLabel).toHaveText(/preview/i)
        if (previewVersion) await expect(versionLabel).toContainText(previewVersion)
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
        const usage = page.locator("details").filter({ has: page.locator("summary", { hasText: "Usage details" }) }).first()
        await expect(usage).not.toHaveAttribute("open")
        if (width >= 1440) {
            // Grouped symbols appear in the page outline, while parameter and return headings do not
            const outline = page.locator("#nd-toc")
            await expect(outline.getByRole("link", { name: /^createClient/ }).first()).toBeAttached()
            await expect(outline.getByRole("link", { name: "Parameters", exact: true })).toHaveCount(0)
        }
        // Category, kind group and symbol headings nest without skipping a level
        const levels = await page.locator("#docs-page-start").locator("h1, h2, h3, h4, h5, h6")
            .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
        expect(levels.filter((level, index) => index > 0 && level > levels[index - 1]! + 1)).toEqual([])
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: info.outputPath(`api-overview-${width}.png`), fullPage: true, animations: "disabled" })
        await page.goto("/docs/preview/api/")
        await expect(page.locator(".docs-content").getByRole("link", { name: "Create a bot" })).toBeVisible()
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
        const guide = authoredGuides.find((entry) => entry.slug === "starter-lifetime")!
        await expect(page.getByRole("heading", { level: 1, name: guide.title, exact: true })).toBeVisible()
        await expect(page.locator(".docs-content")).toContainText("runBot")
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (width === 390) {
            // Scan the settled mobile heading, not the outgoing label halfway through its fade
            await expect(page.locator("[data-toc-popover-trigger]").getByText(guide.navTitle!, { exact: true }))
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
    const overviewTitle = (await page.getByRole("heading", { level: 1 }).textContent())!.trim()
    expect(overviewTitle).not.toBe("")
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
    await expect(page).toHaveURL(/\/docs\/preview\/api\/modules\/(?:js-ts|Effect)\/?#createclient$/)
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
    await expect(page).toHaveURL(/\/docs\/preview\/?$/)
    await expect(page.getByRole("heading", { level: 1, name: overviewTitle, exact: true })).toBeVisible()
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
    // Symbol pages are absent from the browser tree, so their breadcrumbs are built with the page
    const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" })
    await expect(breadcrumb.getByRole("link", { name: "API reference", exact: true })).toHaveAttribute("href", "/docs/preview/api")
    await expect(breadcrumb).toContainText("Interfaces")
    const sidebar = page.locator("#nd-sidebar")
    await expect(sidebar.getByRole("link", { name: "API reference", exact: true })).toBeVisible()
    await expect(sidebar.getByRole("link", { name: "JavaScript & TypeScript", exact: true })).toBeVisible()
    await expect(sidebar.getByRole("link", { name: "Effect API", exact: true })).toBeVisible()
    await expect(sidebar.getByRole("link", { name: "Testing", exact: true })).toBeVisible()
    await expect(sidebar.getByRole("link", { name: "Effect testing", exact: true })).toBeVisible()
    const referenceNavigation = sidebar.locator(".reference-nav")
    await expect(referenceNavigation.locator(".reference-nav-entry")).toHaveCount(4)
    // Besides the landing page and entry points, the reference sidebar links only entry point categories
    const referenceLinks = await referenceNavigation.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")))
    expect(referenceLinks.filter((href) => !/^\/docs\/preview\/api(?:\/modules\/[^/#]+(?:#category-[^/]+)?)?$/.test(href ?? ""))).toEqual([])
    // Entry points share category names, so each category link names its entry point for screen reader link lists
    const categoryLink = sidebar.getByRole("link", { name: "Messages (JavaScript & TypeScript)", exact: true })
    await expect(categoryLink).toHaveAttribute("href", "/docs/preview/api/modules/js-ts#category-messages")
    await expect(categoryLink).toHaveText(/^Messages/)
    const referenceNames = await referenceNavigation.getByRole("link").evaluateAll((links) => links.map((link) => link.textContent?.trim()))
    expect(new Set(referenceNames).size).toBe(referenceNames.length)
    await expect(sidebar.getByRole("button", { name: "Interfaces", exact: true })).toHaveCount(0)
    await sidebar.getByRole("link", { name: "JavaScript & TypeScript", exact: true }).click()
    await expect(page.getByRole("heading", { level: 1, name: "JavaScript & TypeScript", exact: true })).toBeVisible()
    // Each category has its own collapsed kind groups, so open the Interfaces group that lists Client
    const clientGroup = page.locator(".docs-content details")
        .filter({ has: page.locator('a[href="/docs/preview/api/interfaces/js-ts.Client/"]') })
    await expect(clientGroup.locator("summary")).toHaveText("Interfaces")
    await clientGroup.locator("summary").click()
    await expect(clientGroup.getByRole("link", { name: "Client", exact: true })).toBeVisible()
    // A fragment to a collapsed group opens it and shows its class links
    await page.goto("/docs/preview/api/modules/js-ts/#classes")
    const classes = page.locator(".docs-content details").filter({ has: page.locator("#classes") })
    await expect(classes).toHaveAttribute("open", "")
    await expect(classes.locator('a[href^="/docs/preview/api/classes/js-ts."]').first()).toBeVisible()
})

test("Reference navigation highlights the clicked link without moving it and lands category anchors", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/docs/preview/")
    const docs = page.locator('astro-island[component-export="Docs"]')
    await expect(docs).not.toHaveAttribute("ssr")
    const sidebar = page.locator("#nd-sidebar")
    const activeLinks = sidebar.locator('a[data-active="true"]')
    const top = (link: Locator) => link.evaluate((element) => Math.round(element.getBoundingClientRect().top))
    const clicked = [
        { name: "JavaScript & TypeScript", heading: "JavaScript & TypeScript" },
        { name: "Effect API", heading: "Effect API" },
        { name: "API reference", heading: "API reference" },
    ]
    for (const { name, heading } of clicked) {
        const link = sidebar.getByRole("link", { name, exact: true })
        await link.scrollIntoViewIfNeeded()
        const before = await top(link)
        await link.click()
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible()
        await expect(docs).not.toHaveAttribute("ssr")
        // Exactly the clicked link is current, and the new sidebar keeps it where it was clicked
        await expect(activeLinks).toHaveCount(1)
        await expect(activeLinks).toHaveAccessibleName(name)
        await expect.poll(() => top(link)).toBe(before)
    }
    // Both entry points have a Messages category, and only the clicked one becomes current
    await sidebar.getByRole("link", { name: "Effect API", exact: true }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Effect API", exact: true })).toBeVisible()
    const category = sidebar.getByRole("link", { name: "Messages (JavaScript & TypeScript)", exact: true })
    await category.scrollIntoViewIfNeeded()
    const before = await top(category)
    await category.click()
    await expect(page).toHaveURL(/\/api\/modules\/js-ts\/?#category-messages$/)
    await expect(activeLinks).toHaveCount(1)
    await expect(activeLinks).toHaveAccessibleName("Messages (JavaScript & TypeScript)")
    await expect.poll(() => top(category)).toBe(before)
    // Offscreen reference blocks render after the router scrolls, and the heading must still end at the top
    const target = page.locator("#category-messages")
    await expect.poll(() => target.evaluate((element) => Math.abs(Math.round(element.getBoundingClientRect().top)))).toBeLessThanOrEqual(2)
    // A category on the same page becomes current without a page load
    const channels = sidebar.getByRole("link", { name: "Channels (JavaScript & TypeScript)", exact: true })
    await channels.click()
    await expect(activeLinks).toHaveAccessibleName("Channels (JavaScript & TypeScript)")
    // Symbol pages keep their entry point current
    await page.goto("/docs/preview/api/interfaces/js-ts.Client/")
    await expect(docs).not.toHaveAttribute("ssr")
    await expect(activeLinks).toHaveCount(1)
    await expect(activeLinks).toHaveAccessibleName("JavaScript & TypeScript")
})

for (const width of [390, 1440]) {
    test(`Grouped sidebar uses short labels without truncation at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        page.on("response", (response) => {
            if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
        })
        await page.goto("/docs/preview/quick-start/")
        const sidebar = page.locator(width < 768 ? "#nd-sidebar-mobile" : "#nd-sidebar")
        const openMobileSidebar = async () => {
            await page.getByRole("button", { name: "Open Sidebar", exact: true }).click()
            await expect(sidebar).toHaveAttribute("data-state", "open")
        }
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
        // Group labels are plain text, which keeps the Effect group apart from the Effect reference link
        for (const group of navigationGroups)
            await expect(sidebar.getByText(group, { exact: true }).and(sidebar.locator(":not(a)"))).toBeVisible()
        for (const item of [
            { name: "Overview", href: "/docs/preview" },
            { name: "API reference", href: "/docs/preview/api" },
            { name: "JavaScript & TypeScript", href: "/docs/preview/api/modules/js-ts" },
            { name: "Effect API", href: "/docs/preview/api/modules/Effect" },
            { name: "Testing", href: "/docs/preview/api/modules/testing" },
            { name: "Effect testing", href: "/docs/preview/api/modules/Effect-testing" },
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
        await page.screenshot({ path: info.outputPath(`sidebar-${width}.png`), animations: "disabled" })
        const selected = sidebar.getByRole("link", { name: navigableGuide!.navTitle!, exact: true })
        await selected.click()
        await expect(page).toHaveURL(new RegExp(`/docs/preview/${navigableGuide!.slug}/?$`))
        await expect(page.getByRole("heading", { level: 1, name: navigableGuide!.title, exact: true })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        // Sidebar navigation also leaves the guides for the reference landing page
        if (width < 768) await openMobileSidebar()
        await sidebar.getByRole("link", { name: "API reference", exact: true }).click()
        await expect(page).toHaveURL(/\/docs\/preview\/api\/?$/)
        await expect(page.getByRole("heading", { level: 1, name: "API reference", exact: true })).toBeVisible()
        expect(errors).toEqual([])
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
        for (const guide of authoredGuides) {
            await page.goto(`/docs/preview/${guide.slug}/`)
            await expect(page.getByRole("heading", { level: 1, name: guide.title, exact: true })).toBeVisible()
            await expect(page.locator(".docs-content pre:visible"), `Every ${guide.slug} example is visible`)
                .toHaveCount(guide.examples)
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        }
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
    await expect(blocks.nth(0).locator("[data-command-code]")).toHaveText("pnpm exec fluxerly agents")
    const run = blocks.nth(1)
    await expect(run.locator("[data-command-code]")).toHaveText("node --env-file=.env bot.js")
    await expect(blocks.last().locator("[data-command-code]")).toHaveText("pnpm add --save-dev @types/node")
    await run.getByRole("button", { name: "Copy", exact: true }).click()
    await expect(run.getByRole("status")).toHaveText("Copied")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("node --env-file=.env bot.js")
    await page.locator(".docs-content").getByRole("link", { name: /client.s message methods/ }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Client", exact: true })).toBeVisible()
    await page.goBack()
    await expect(blocks.first().getByLabel("Package manager", { exact: true })).toHaveValue("pnpm")
    await page.reload()
    await expect(blocks.first().getByLabel("Package manager", { exact: true })).toHaveValue("pnpm")
    // Several blocks on one page follow each other, and the saved choice carries to another guide
    await page.goto("/docs/preview/effect-first-bot/")
    const effectBlocks = page.locator("[data-command-block]")
    expect(await effectBlocks.count()).toBeGreaterThan(1)
    for (const block of await effectBlocks.all()) {
        await expect(block.getByLabel("Package manager", { exact: true })).toHaveValue("pnpm")
    }
    await effectBlocks.last().getByLabel("Package manager", { exact: true }).selectOption("npm")
    for (const block of await effectBlocks.all()) {
        await expect(block.getByLabel("Package manager", { exact: true })).toHaveValue("npm")
    }
    await expect(effectBlocks.last().locator("[data-command-code]")).toHaveText("npm list effect")
    // The preview's Effect peer is a stable range, so its install keeps the package manager's normal range
    await expect(effectBlocks.filter({ hasText: "npm install effect@" })).toHaveCount(1)
    await effectBlocks.first().getByLabel("Package manager", { exact: true }).selectOption("bun")
    await expect(effectBlocks.filter({ hasText: "bun add effect@" })).toHaveCount(1)
    await expect(effectBlocks.last().locator("[data-command-code]")).toHaveText("bun why effect")
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()
    expect(accessibility.violations).toEqual([])
    expect(errors).toEqual([])
})

test("Back navigation disposes a pending React hydration without errors and preserves command choices", async ({ page, context }) => {
    const session = await context.newCDPSession(page)
    await session.send("Emulation.setCPUThrottlingRate", { rate: 6 })
    await page.addInitScript(() => {
        const NativeMessageChannel = window.MessageChannel
        let paused = false
        const pending: (() => void)[] = []
        // Hold React's scheduled work without delaying Astro's navigation or DOM preferences
        window.MessageChannel = class extends NativeMessageChannel {
            constructor() {
                super()
                // Capture delivery too, so work posted before the pause cannot escape the gate
                this.port1.addEventListener("message", (event) => {
                    if (!paused) return
                    event.stopImmediatePropagation()
                    pending.push(() => this.port1.dispatchEvent(new MessageEvent("message", { data: event.data })))
                }, { capture: true })
            }
        }
        window.addEventListener("test:pause-react", () => { paused = true })
        window.addEventListener("test:resume-react", () => {
            paused = false
            for (const send of pending.splice(0)) send()
        })
    })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto("/docs/preview/quick-start/")
    // The shortcut hint appears after React commits, unlike Astro's ssr marker
    await expect(page.getByRole("button", { name: "Search Ctrl K", exact: true })).toBeVisible()
    const blocks = page.locator("[data-command-block]")
    await blocks.first().getByLabel("Package manager", { exact: true }).selectOption("pnpm")
    await expect(blocks.first().locator("[data-command-code]")).toHaveText("pnpm exec fluxerly agents")
    await page.evaluate(() => window.dispatchEvent(new Event("test:pause-react")))
    await page.locator(".docs-content").getByRole("link", { name: /client.s message methods/ }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Client", exact: true })).toBeVisible()
    const island = page.locator('astro-island[component-export="Docs"]')
    await expect(island).not.toHaveAttribute("ssr")
    const departing = (await island.elementHandle())!
    // Prove the intended timing window rather than relying on CPU speed
    expect(await departing.evaluate((element) => {
        const key = Object.keys(element).find((key) => key.startsWith("__reactContainer"))!
        const root = (element as unknown as Record<string, { stateNode: { current: { memoizedState: { isDehydrated: boolean } } } }>)[key]
        return root.stateNode.current.memoizedState.isDehydrated
    })).toBe(true)
    await page.goBack()
    await expect(page.getByRole("heading", { level: 1, name: quickStartTitle, exact: true })).toBeVisible()
    await expect(blocks.first().getByLabel("Package manager", { exact: true })).toHaveValue("pnpm")
    expect(await departing.evaluate((element) => element.isConnected)).toBe(false)
    await page.evaluate(() => window.dispatchEvent(new Event("test:resume-react")))
    // Deferred teardown must eventually release the outgoing root, not merely hide its error
    await expect.poll(() => departing.evaluate((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactContainer") && Reflect.get(element, key) !== null),
    )).toBe(false)
    await expect(page.getByRole("button", { name: "Search Ctrl K", exact: true })).toBeVisible()
    await expect(blocks.first().locator("[data-command-code]")).toHaveText("pnpm exec fluxerly agents")
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

test("Without client JavaScript, the quick start remains readable and runnable", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    try {
        const page = await context.newPage()
        await page.goto("/docs/preview/quick-start/")
        await expect(page).toHaveURL(/\/docs\/preview\/quick-start\/?$/)
        await expect(page.locator(".version-label")).toHaveText(/preview/i)
        if (previewVersion) await expect(page.locator(".version-label")).toContainText(previewVersion)
        await expect(page.getByRole("heading", { level: 1, name: quickStartTitle, exact: true })).toBeVisible()
        // The server-rendered command defaults to the JavaScript example and npm
        const command = page.locator("[data-command-block]").filter({ hasText: "--env-file" })
        await expect(command.locator("[data-command-code]")).toHaveText("node --env-file=.env bot.js")
        await expect(command.getByLabel("Package manager", { exact: true })).toBeDisabled()
        await expect(command.locator("[data-command-fallback]")).toBeVisible()
        // Controls that need scripts are disabled or absent, while the default example stays visible
        const example = page.locator("[data-example-block]").first()
        await expect(example.getByRole("combobox", { name: "Example language" })).toBeDisabled()
        await expect(example.locator('[data-example-variant="js"]')).toBeVisible()
        await expect(example.locator('[data-example-variant="ts"]')).toBeHidden()
        await expect(example.locator("[data-example-fallback]")).toBeVisible()
        await expect(example.getByRole("button", { name: "Copy" })).toHaveCount(0)
        await expect(page.locator("[data-example-filename]")).toHaveText("bot.js")
        await expect(page.locator(".docs-content")).not.toContainText("@VERSION")
    } finally { await context.close() }
})

test("Guide pages send only the navigation tree the sidebar renders", async ({ page }) => {
    await page.goto("/docs/preview/quick-start/")
    await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
    const props = (await page.locator('astro-island[component-export="Docs"]').getAttribute("props"))!
    const tree = JSON.stringify(JSON.parse(props).tree)
    expect(tree).toContain("/docs/preview/api/modules/js-ts")
    expect(tree).toContain("/docs/preview/api/modules/Effect")
    expect(tree).toContain("/docs/preview/api/modules/testing")
    expect(tree).toContain("/docs/preview/api/modules/Effect-testing")
    // Symbol pages would otherwise repeat hundreds of reference URLs in every page
    expect(tree).not.toMatch(/\/docs\/preview\/api\/(?:interfaces|classes|enums|functions|types|variables)\//)
})

test("A skip link moves keyboard focus past the navigation to the page content", async ({ page }) => {
    await page.goto("/docs/preview/quick-start/")
    await expect(page.locator('astro-island[component-export="Docs"]')).not.toHaveAttribute("ssr")
    await page.keyboard.press("Tab")
    const skip = page.getByRole("link", { name: "Skip to content", exact: true })
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()
    await page.keyboard.press("Enter")
    await expect(page.locator("#docs-page-start")).toBeFocused()
    await page.keyboard.press("Tab")
    // The next stop is inside the content, not the sidebar
    expect(await page.evaluate(() => document.activeElement?.closest("#docs-page-start") !== null)).toBe(true)
})

test("Guide pages copy their Markdown twin and link to it without JavaScript", async ({ page, context, request, browser }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.goto("/docs/preview/quick-start/")
    const copy = page.getByRole("button", { name: "Copy page as Markdown", exact: true })
    await expect(copy).toBeVisible()
    await copy.click()
    await expect(page.locator("[data-copy-markdown-status]")).toHaveText("Copied")
    const markdown = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n")
    expect(markdown.startsWith(`# ${quickStartTitle}\n`)).toBe(true)
    expect(markdown).toContain("```sh\nnode --env-file=.env bot.js\n```")
    expect(markdown).not.toContain("```command")
    expect(markdown).not.toContain("{{")
    const twin = await request.get("/docs/preview/quick-start.md")
    expect(twin.headers()["content-type"]).toContain("text/markdown")
    expect((await twin.text()).replaceAll("\r\n", "\n")).toBe(markdown)
    await page.goto("/docs/preview/api/interfaces/js-ts.Client/")
    await expect(page.getByRole("button", { name: "Copy page as Markdown" })).toHaveCount(0)
    const noScript = await browser.newContext({ javaScriptEnabled: false })
    try {
        const plain = await noScript.newPage()
        await plain.goto("http://127.0.0.1:4322/docs/preview/quick-start/")
        await expect(plain.getByRole("button", { name: "Copy page as Markdown" })).toBeHidden()
        await expect(plain.getByRole("link", { name: "View as Markdown", exact: true })).toHaveAttribute("href", "/docs/preview/quick-start.md")
    } finally { await noScript.close() }
})

test("Assistant indexes list the version's guides and reference pages", async ({ request }) => {
    const index = await request.get("/docs/preview/llms.txt")
    expect(index.status()).toBe(200)
    expect(index.headers()["x-robots-tag"]).toBe("noindex, nofollow")
    const text = await index.text()
    for (const guide of authoredGuides) expect(text).toContain(`](/docs/preview/${guide.slug}.md)`)
    expect(text).toContain("](/docs/preview/api/interfaces/js-ts.Client)")
    expect(text).toContain("/docs/preview/llms-reference.txt")
    const full = (await (await request.get("/docs/preview/llms-full.txt")).text()).replaceAll("\r\n", "\n")
    expect(full).toContain(`# Guide: ${quickStartTitle}`)
    // Guides and reference are separate files so each fits in one AI context, and release history stays out
    expect(full).not.toContain("\nPage: /docs/preview/api/")
    expect(full).not.toContain("# Guide: Changelog")
    const reference = (await (await request.get("/docs/preview/llms-reference.txt")).text()).replaceAll("\r\n", "\n")
    // Each condensed symbol names its reference page and lists member signatures as plain text
    const client = reference.split(/\n(?=## )/).find((section) => section.includes("\nPage: /docs/preview/api/interfaces/js-ts.Client\n"))
    expect(client).toBeDefined()
    expect(client).toMatch(/^- `\w+(?:<[^`]*>)?\([^`]*\)[^`]*`/m)
    expect(reference).not.toContain("<details")
    const root = await request.get("/llms.txt")
    expect(root.status()).toBe(200)
    expect(await root.text()).toContain("](/docs/preview/llms.txt)")
})

test("Pages point programs to their Markdown version and the AI index", async ({ page }) => {
    await page.goto("/docs/preview/quick-start/")
    await expect(page.locator('head link[rel="alternate"][type="text/markdown"]')).toHaveAttribute("href", "/docs/preview/quick-start.md")
    await expect(page.locator('head link[rel="alternate"][type="text/plain"]')).toHaveAttribute("href", "/docs/preview/llms.txt")
    await expect(page.getByRole("link", { name: "Docs for AI tools", exact: true })).toHaveAttribute("href", "/docs/preview/llms.txt")
    await page.goto("/docs/preview/api/interfaces/js-ts.Client/")
    await expect(page.locator('head link[rel="alternate"][type="text/markdown"]')).toHaveCount(0)
    await expect(page.locator('head link[rel="alternate"][type="text/plain"]')).toHaveAttribute("href", "/docs/preview/llms.txt")
})
