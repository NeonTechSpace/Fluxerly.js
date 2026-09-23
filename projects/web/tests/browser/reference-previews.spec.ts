import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const routerPath = "/docs/preview/api/interfaces/Effect.NativePrefixCommandRouter/"
const commandPath = "/docs/preview/api/interfaces/Effect.NativePrefixCommand/"

test("Public type previews support hover, focus, dismissal and ordinary navigation", async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await page.goto(`${routerPath}#register`)
    const link = page.locator(".docs-content").getByRole("link", { name: "NativePrefixCommand", exact: true }).first()
    const preview = page.getByRole("dialog", { name: "NativePrefixCommand type preview", exact: true })
    await link.hover()
    await expect(preview).toBeVisible()
    await expect(preview.locator(".reference-preview-description")).not.toBeEmpty()
    await expect(preview.locator(".reference-preview-members")).toContainText("execute")
    await expect(preview.getByRole("link", { name: "Open type", exact: true })).toHaveAttribute("href", new RegExp(`${commandPath}$`))
    await preview.hover()
    await expect(preview).toBeVisible()
    await page.screenshot({ path: info.outputPath("public-type-preview-desktop.png"), animations: "disabled" })
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([])
    await preview.getByRole("link", { name: "Open type", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${commandPath}$`))
    await page.goBack()
    await expect(page.getByRole("heading", { level: 1, name: "NativePrefixCommandRouter", exact: true })).toBeVisible()
    await link.hover()
    await expect(preview).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(preview).not.toBeVisible()
    await link.focus()
    // Leave and re-enter after dismissal, as a keyboard reader revisiting the link would
    await link.press("Tab")
    await page.keyboard.press("Shift+Tab")
    await expect(link).toBeFocused()
    await expect(preview).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(preview).not.toBeVisible()
    await link.click()
    await expect(page).toHaveURL(new RegExp(`${commandPath}$`))
    await expect(page.getByRole("heading", { level: 1, name: "NativePrefixCommand", exact: true })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole("heading", { level: 1, name: "NativePrefixCommandRouter", exact: true })).toBeVisible()
    await page.locator(".docs-content").getByRole("link", { name: "NativePrefixCommand", exact: true }).first().hover()
    await expect(preview).toBeVisible()
    expect(errors).toEqual([])
})

test("Touch readers can preview a type without consuming its navigation link", async ({ browser }, info) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    try {
        await page.goto(`http://127.0.0.1:4322${routerPath}#register`)
        const button = page.getByRole("button", { name: "Preview NativePrefixCommand", exact: true }).first()
        await expect(button).toBeVisible()
        const size = await button.boundingBox()
        expect(size!.width).toBeGreaterThanOrEqual(24)
        expect(size!.height).toBeGreaterThanOrEqual(24)
        await button.tap()
        const preview = page.getByRole("dialog", { name: "NativePrefixCommand type preview", exact: true })
        await expect(preview).toBeVisible()
        await expect(button).toHaveAttribute("aria-expanded", "true")
        await expect(preview.getByRole("button", { name: "Close type preview" })).toBeFocused()
        const bounds = await preview.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391)
        const destination = await preview.getByRole("link", { name: "Open type", exact: true }).boundingBox()
        expect(destination!.y + destination!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: info.outputPath("public-type-preview-mobile.png"), animations: "disabled" })
        await preview.getByRole("button", { name: "Close type preview" }).tap()
        await expect(preview).not.toBeVisible()
        await expect(button).toHaveAttribute("aria-expanded", "false")
        await page.locator(".docs-content").getByRole("link", { name: "NativePrefixCommand", exact: true }).first().tap()
        await expect(page).toHaveURL(new RegExp(`${commandPath}$`))
    } finally {
        await context.close()
    }
})

test("Preview failures preserve explicit feedback and the public type destination", async ({ page }) => {
    await page.route(`**${commandPath}`, (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "Unavailable" }))
    await page.goto(routerPath)
    const link = page.locator(".docs-content").getByRole("link", { name: "NativePrefixCommand", exact: true }).first()
    await link.hover()
    const preview = page.getByRole("dialog", { name: "NativePrefixCommand type preview", exact: true })
    await expect(preview).toBeVisible()
    await expect(preview.locator(".reference-preview-description")).not.toBeEmpty()
    await expect(preview.locator(".reference-preview-members")).toHaveCount(0)
    await expect(preview.getByRole("link", { name: "Open type", exact: true })).toHaveAttribute("href", new RegExp(`${commandPath}$`))
    await expect(link).toHaveAttribute("href", commandPath)
})

test("Hover previews do not fetch a different documentation version", async ({ page }) => {
    const otherVersion = "/docs/1000.0.0/api/interfaces/Effect.NativePrefixCommand/"
    const requests: string[] = []
    page.on("request", (request) => requests.push(request.url()))
    await page.route(`**${routerPath}`, async (route) => {
        const response = await route.fetch()
        // Isolate preview fetching from the router's independent navigation prefetch
        await route.fulfill({ response, body: (await response.text()).replaceAll(`href="${commandPath}"`, `href="${otherVersion}" data-astro-prefetch="false"`) })
    })
    await page.goto(routerPath)
    const link = page.locator(".docs-content").getByRole("link", { name: "NativePrefixCommand", exact: true }).first()
    await expect(link).toHaveAttribute("href", otherVersion)
    await link.focus()
    await link.hover()
    await expect(page.locator(".reference-preview")).not.toBeVisible()
    expect(await link.evaluate((node) => node.nextElementSibling?.classList.contains("reference-preview-trigger") ?? false)).toBe(false)
    expect(requests.some((url) => url.includes(otherVersion))).toBe(false)
})

for (const width of [390, 1440, 1920]) {
    test(`Prose boundaries and syntax colours remain readable at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto("/docs/preview/api/interfaces/Effect.Members/")
        const article = page.locator(".docs-content")
        const intro = article.locator(":scope > p:not(h2 ~ p)")
        await expect(intro.first()).toBeVisible()
        const boxes = await intro.evaluateAll((nodes) => nodes.map((node) => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom })))
        for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.top - boxes[i - 1]!.bottom).toBeGreaterThanOrEqual(16)
        await expect(article.locator(".prose-keyword").filter({ hasText: /^HTTP$/ }).first()).toBeVisible()
        await page.screenshot({ path: info.outputPath(`members-prose-${width}.png`), animations: "disabled" })
        await page.goto("/docs/preview/api/interfaces/Effect.Members/#addrole")
        const signature = article.locator("blockquote").first()
        const signatureText = await signature.evaluate((node) => {
            const copy = node.cloneNode(true) as HTMLElement
            copy.querySelectorAll(".reference-preview-trigger").forEach((button) => button.remove())
            return copy.textContent?.replace(/\s+/g, " ").trim()
        })
        expect(signatureText).toBe("addRole(member, roleId, options?): Effect<void, GuildOperationFailure>")
        const colours = await signature.locator(".syntax-token").evaluateAll((nodes) => [...new Set(nodes.map((node) => getComputedStyle(node).color))])
        expect(colours.length).toBeGreaterThanOrEqual(3)
        await expect(signature.getByRole("link", { name: "GuildOperationFailure", exact: true })).toHaveAttribute("href", "/docs/preview/api/types/js-ts.GuildOperationFailure/")
        await expect(article.locator(".prose-constant").filter({ hasText: /^MANAGE_ROLES$/ }).first()).toBeVisible()
        await expect(article.locator(".prose-number").filter({ hasText: /^204$/ }).first()).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()
        expect(accessibility.violations).toEqual([])
        await page.screenshot({ path: info.outputPath(`members-signature-${width}.png`), animations: "disabled" })
    })
    test(`Client introductions and linked return types are readable at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        for (const entry of ["Effect", "js-ts"]) {
            await page.goto(`/docs/preview/api/functions/${entry}.createClient/`)
            const article = page.locator(".docs-content")
            const details = article.locator("details").filter({ has: page.getByText("Usage details", { exact: true }) })
            await expect(details).toHaveCount(1)
            await expect(details).not.toHaveAttribute("open", "")
            await expect(article.locator("blockquote")).toHaveCount(2)
            const result = article.locator("blockquote").last()
            await expect(result.locator("br")).toHaveCount(entry === "Effect" ? 4 : 0)
            await expect(result.getByRole("link", { name: "ConfigurationError", exact: true })).toHaveAttribute("href", "/docs/preview/api/classes/js-ts.ConfigurationError/")
            await page.screenshot({ path: info.outputPath(`${entry}-intro-${width}.png`), animations: "disabled" })
            await details.locator("summary").press("Enter")
            await expect(details).toHaveAttribute("open", "")
            await expect(details.locator("p").first()).toBeVisible()
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
            await details.scrollIntoViewIfNeeded()
            await page.screenshot({ path: info.outputPath(`${entry}-details-${width}.png`), animations: "disabled" })
        }
    })
    test(`Reference generics and parameters stay compact at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(`${routerPath}#register`)
        const sections = await page.locator("#register").evaluate((heading) => {
            const nodes: Element[] = []
            let node = heading.nextElementSibling
            while (node && node.tagName !== "H3") { nodes.push(node); node = node.nextElementSibling }
            return {
                tables: nodes.filter((node) => node.tagName === "TABLE").map((table) => Array.from(table.querySelectorAll("tbody tr")).map((row) => Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent?.trim()))),
                genericHeadings: nodes.filter((node) => node.tagName === "H5").length,
                codeBackgrounds: nodes.flatMap((node) => Array.from(node.querySelectorAll("code"))).map((code) => getComputedStyle(code).backgroundColor),
            }
        })
        expect(sections.genericHeadings).toBe(0)
        expect(sections.tables).toHaveLength(2)
        expect(sections.tables[0]!.map((row) => row[0])).toEqual(["E", "R2", expect.stringContaining("S")])
        expect(sections.tables[1]!.map((row) => row[0])).toEqual(["command", "options?"])
        expect(sections.codeBackgrounds.every((background) => background === "rgba(0, 0, 0, 0)")).toBe(true)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.locator("#register").scrollIntoViewIfNeeded()
        await page.screenshot({ path: info.outputPath(`register-format-${width}.png`), animations: "disabled" })
        await page.locator("#type-parameters-2").scrollIntoViewIfNeeded()
        await page.screenshot({ path: info.outputPath(`register-tables-${width}.png`), animations: "disabled" })
        for (const module of ["js-ts", "Effect"]) {
            await page.goto(`/docs/preview/api/modules/${module}/`)
            const borders = await page.locator(".docs-content details").evaluateAll((nodes) => nodes.map((node) => ({ top: getComputedStyle(node).borderTopWidth, bottom: getComputedStyle(node).borderBottomWidth })))
            expect(borders.length).toBeGreaterThan(1)
            expect(borders.every((border) => border.top === "1px" && border.bottom === "0px")).toBe(true)
            await page.locator(".docs-content details").first().scrollIntoViewIfNeeded()
            await page.screenshot({ path: info.outputPath(`single-rule-${module}-${width}.png`), animations: "disabled" })
        }
    })
}
