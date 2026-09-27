import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

// Client is the SDK's core entry point. Preview targets are chosen from its links by structure, not by symbol name
const clientPath = "/docs/preview/api/interfaces/js-ts.Client/"
const symbolPage = /^\/docs\/preview\/api\/(interfaces|classes|enums)\/[^/#]+\/$/
const groupedSymbol = /^\/docs\/preview\/api\/modules\/[^/#]+\/#.+$/
const atPath = (path: string) => (url: URL) => url.pathname === path

/** The first visible reference link in the content whose target matches, excluding links to the current page */
async function referenceLink(page: Page, pattern: RegExp) {
    const found = await page.locator(".docs-content a[href]").evaluateAll((links, source) => {
        const pattern = new RegExp(source)
        const link = links.find((link) => pattern.test(link.getAttribute("href")!)
            && new URL((link as HTMLAnchorElement).href).pathname !== location.pathname
            && link.getClientRects().length > 0)
        return link ? { href: link.getAttribute("href")!, name: link.textContent!.trim() } : undefined
    }, pattern.source)
    expect(found, `A visible link matches ${pattern}`).toBeDefined()
    const link = page.locator(`.docs-content a[href="${found!.href}"]`).filter({ visible: true }).first()
    const preview = page.getByRole("dialog", { name: `${found!.name} reference preview`, exact: true })
    return { ...found!, link, preview }
}

/** The kind label names the kind group of its target, such as Interface for interfaces or Type alias for Type Aliases */
async function expectKindOf(preview: Locator, group: string) {
    const kind = (await preview.locator(".reference-preview-kind").textContent())!.trim()
    // Type is the fallback when the target's kind is unknown
    expect(kind).not.toBe("Type")
    expect(group.toLowerCase().startsWith(kind.toLowerCase()), `${kind} names ${group}`).toBe(true)
}

/** The kind group heading above a grouped symbol on the current entry point page */
const groupOf = (page: Page, id: string) => page.locator(".docs-content").evaluate((content, id) => {
    const heading = content.querySelector(`[id="${CSS.escape(id)}"]`)!
    const level = Number(heading.tagName[1])
    let group = heading.previousElementSibling
    while (group && !(/^H[1-6]$/.test(group.tagName) && Number(group.tagName[1]) < level)) group = group.previousElementSibling
    return group?.textContent?.trim() ?? ""
}, id)

/** A reference link resolves to a page of this version and, when it has a fragment, to an element on that page */
async function expectResolves(request: APIRequestContext, href: string) {
    const url = new URL(href, "http://127.0.0.1:4322")
    const response = await request.get(url.pathname)
    expect(response.status(), href).toBe(200)
    if (url.hash) expect(await response.text(), href).toContain(`id="${decodeURIComponent(url.hash.slice(1))}"`)
}

test("Public reference previews support hover, focus, dismissal and ordinary navigation", async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await page.goto(clientPath)
    const { href, name, link, preview } = await referenceLink(page, symbolPage)
    await link.hover()
    await expect(preview).toBeVisible()
    await expectKindOf(preview, symbolPage.exec(href)![1]!)
    await expect(preview.locator(".reference-preview-description")).not.toBeEmpty()
    const members = preview.locator(".reference-preview-members code")
    expect(await members.count()).toBeGreaterThan(0)
    const member = (await members.first().textContent())!.trim()
    await expect(preview.getByRole("link", { name: "Open reference", exact: true })).toHaveAttribute("href", new URL(href, page.url()).href)
    await preview.hover()
    await expect(preview).toBeVisible()
    await page.screenshot({ path: info.outputPath("public-type-preview-desktop.png"), animations: "disabled" })
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([])
    await preview.getByRole("link", { name: "Open reference", exact: true }).click()
    await expect(page).toHaveURL(atPath(href))
    await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible()
    // The preview summarizes the page it opens
    await expect(page.locator(".docs-content")).toContainText(member)
    await page.goBack()
    await expect(page.getByRole("heading", { level: 1, name: "Client", exact: true })).toBeVisible()
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
    await expect(page).toHaveURL(atPath(href))
    await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole("heading", { level: 1, name: "Client", exact: true })).toBeVisible()
    await link.hover()
    await expect(preview).toBeVisible()
    expect(errors).toEqual([])
})

test("Touch readers switch type links to previews with one toggle without losing navigation", async ({ browser }, info) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    try {
        await page.goto(`http://127.0.0.1:4322${clientPath}`)
        const toggle = page.getByRole("button", { name: "Preview types on tap", exact: true })
        await expect(toggle).toBeVisible()
        await expect(page.getByRole("button", { name: /^Preview / })).toHaveCount(1)
        const size = await toggle.boundingBox()
        expect(size!.width).toBeGreaterThanOrEqual(24)
        expect(size!.height).toBeGreaterThanOrEqual(24)
        await toggle.tap()
        await expect(toggle).toHaveAttribute("aria-pressed", "true")
        const { href, link, preview } = await referenceLink(page, symbolPage)
        await link.tap()
        await expect(preview).toBeVisible()
        await expect(page).toHaveURL(atPath(clientPath))
        await expect(preview.getByRole("button", { name: "Close reference preview" })).toBeFocused()
        const bounds = await preview.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391)
        const destination = await preview.getByRole("link", { name: "Open reference", exact: true }).boundingBox()
        expect(destination!.y + destination!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: info.outputPath("public-type-preview-mobile.png"), animations: "disabled" })
        await preview.getByRole("button", { name: "Close reference preview" }).tap()
        await expect(preview).not.toBeVisible()
        await toggle.tap()
        await expect(toggle).toHaveAttribute("aria-pressed", "false")
        await link.tap()
        await expect(page).toHaveURL(atPath(href))
    } finally {
        await context.close()
    }
})

test("Keyboard readers reach a preview from its link without a tab stop per type", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(clientPath)
    const content = page.locator(".docs-content")
    // Previewable type links add no buttons of their own, only the shortcut on each link
    expect(await content.locator('a[aria-keyshortcuts="Alt+ArrowDown"]').count()).toBeGreaterThan(20)
    await expect(content.locator("button:not([data-example-copy]):not([data-command-copy])")).toHaveCount(0)
    const { link, preview } = await referenceLink(page, symbolPage)
    await expect(link).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowDown")
    await link.focus()
    await expect(preview).toBeVisible()
    await expect(link).toHaveAttribute("aria-describedby", "reference-preview")
    await page.keyboard.press("Alt+ArrowDown")
    await expect(preview.getByRole("button", { name: "Close reference preview" })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(preview.getByRole("list", { name: "Public members" })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(preview).not.toBeVisible()
    await expect(link).toBeFocused()
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([])
})

test("Grouped symbols preview their entry point section", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(clientPath)
    const grouped = await referenceLink(page, groupedSymbol)
    await grouped.link.hover()
    await expect(grouped.preview).toBeVisible()
    await expect(grouped.preview.locator(".reference-preview-description")).not.toBeEmpty()
    await expect(grouped.preview.getByRole("link", { name: "Open reference", exact: true })).toHaveAttribute("href", new URL(grouped.href, page.url()).href)
    const kind = (await grouped.preview.locator(".reference-preview-kind").textContent())!.trim()
    const [path, id] = grouped.href.split("#") as [string, string]
    await page.goto(path)
    expect(kind).not.toBe("Type")
    expect((await groupOf(page, id)).toLowerCase().startsWith(kind.toLowerCase())).toBe(true)
    // Inside category sections, grouped type declarations still list their members
    const declaration = await page.locator(".docs-content").evaluate((content, source) => {
        const pattern = new RegExp(source)
        for (const link of content.querySelectorAll("a[href]")) {
            const href = link.getAttribute("href")!
            if (!pattern.test(href) || link.getClientRects().length === 0) continue
            const heading = content.querySelector(`[id="${CSS.escape(decodeURIComponent(href.split("#")[1]!))}"]`)
            if (!heading || !/^H[2-5]$/.test(heading.tagName)) continue
            const level = Number(heading.tagName[1])
            let text = ""
            let declared = false
            for (let node = heading.nextElementSibling; node && !(/^H[1-6]$/.test(node.tagName) && Number(node.tagName[1]) <= level); node = node.nextElementSibling) {
                text += ` ${node.textContent}`
                if (node.textContent?.trim() === "Type Declaration" && node.nextElementSibling?.tagName === "TABLE") declared = true
            }
            if (declared) return { href, id: heading.id, name: link.textContent!.trim(), text: text.replace(/\s+/g, " ") }
        }
        return undefined
    }, groupedSymbol.source)
    expect(declaration).toBeDefined()
    await page.locator(`.docs-content a[href="${declaration!.href}"]`).filter({ visible: true }).first().hover()
    const declarationPreview = page.getByRole("dialog", { name: `${declaration!.name} reference preview`, exact: true })
    await expect(declarationPreview).toBeVisible()
    await expectKindOf(declarationPreview, await groupOf(page, declaration!.id))
    const members = declarationPreview.locator(".reference-preview-members code")
    expect(await members.count()).toBeGreaterThan(0)
    expect(declaration!.text).toContain((await members.first().textContent())!.trim())
})

test("Preview failures preserve explicit feedback and the public type destination", async ({ page }) => {
    await page.goto(clientPath)
    const { href, link, preview } = await referenceLink(page, symbolPage)
    await page.route(`**${href}`, (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "Unavailable" }))
    await link.hover()
    await expect(preview).toBeVisible()
    await expect(preview.locator(".reference-preview-kind")).toHaveText("Type")
    await expect(preview.locator(".reference-preview-description")).not.toBeEmpty()
    await expect(preview.locator(".reference-preview-members")).toHaveCount(0)
    await expect(preview.getByRole("link", { name: "Open reference", exact: true })).toHaveAttribute("href", new URL(href, page.url()).href)
    await expect(link).toHaveAttribute("href", href)
})

test("Hover previews do not fetch a different documentation version", async ({ page }) => {
    await page.goto(clientPath)
    const { href } = await referenceLink(page, symbolPage)
    const otherVersion = href.replace("/docs/preview/", "/docs/1000.0.0/")
    const requests: string[] = []
    page.on("request", (request) => requests.push(request.url()))
    await page.route(`**${clientPath}`, async (route) => {
        const response = await route.fetch()
        // Isolate preview fetching from the page's independent navigation prefetch
        await route.fulfill({ response, body: (await response.text()).replaceAll(`href="${href}"`, `href="${otherVersion}" data-astro-prefetch="false"`) })
    })
    await page.reload()
    const link = page.locator(`.docs-content a[href="${otherVersion}"]`).filter({ visible: true }).first()
    await link.focus()
    await link.hover()
    await expect(page.locator(".reference-preview")).not.toBeVisible()
    await expect(link).not.toHaveAttribute("aria-keyshortcuts")
    expect(requests.some((url) => url.includes(otherVersion))).toBe(false)
})

for (const width of [390, 1440, 1920]) {
    test(`Prose boundaries and syntax colours remain readable at ${width}px`, async ({ page, request }, info) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto("/docs/preview/api/interfaces/Effect.Members/")
        const article = page.locator(".docs-content")
        const intro = article.locator(":scope > p:not(h2 ~ p)")
        await expect(intro.first()).toBeVisible()
        const boxes = await intro.evaluateAll((nodes) => nodes.map((node) => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom })))
        for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.top - boxes[i - 1]!.bottom).toBeGreaterThanOrEqual(16)
        // Highlighted prose terms stay visible and distinct from the surrounding text
        for (const highlight of [".prose-keyword", ".prose-constant", ".prose-number"]) {
            const term = article.locator(highlight).filter({ visible: true }).first()
            await expect(term).toBeVisible()
            expect(await term.evaluate((node) => getComputedStyle(node).color !== getComputedStyle(node.parentElement!).color)).toBe(true)
        }
        await page.screenshot({ path: info.outputPath(`members-prose-${width}.png`), animations: "disabled" })
        // The first member signature belongs to its heading, is coloured by token and links its types
        const member = article.locator(":scope > h3").first()
        const memberName = (await member.textContent())!.trim().replace(/\(\)$/, "")
        const signature = member.locator("xpath=following-sibling::*[1][self::blockquote]")
        await signature.scrollIntoViewIfNeeded()
        const signatureText = await signature.evaluate((node) => node.textContent?.replace(/\s+/g, " ").trim())
        expect(signatureText!.startsWith(`${memberName}(`) || signatureText!.startsWith(`${memberName}<`)).toBe(true)
        const colours = await signature.locator(".syntax-token").evaluateAll((nodes) => [...new Set(nodes.map((node) => getComputedStyle(node).color))])
        expect(colours.length).toBeGreaterThanOrEqual(3)
        const links = await signature.locator("a[href]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")!))
        expect(links.some((href) => href.startsWith("/docs/preview/api/"))).toBe(true)
        for (const href of links) {
            if (href.startsWith("/")) await expectResolves(request, href)
            else expect(href).toMatch(/^https:\/\//)
        }
        // Effect types link to the Effect documentation
        await expect(article.locator('blockquote a[href^="https://effect.website/docs/"]').first()).toBeAttached()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()
        expect(accessibility.violations).toEqual([])
        await page.screenshot({ path: info.outputPath(`members-signature-${width}.png`), animations: "disabled" })
    })
    test(`Client introductions and linked return types are readable at ${width}px`, async ({ page, request }, info) => {
        await page.setViewportSize({ width, height: 900 })
        // The grouped function is the content between its heading and the next symbol, kind group or category
        // heading. Category sections make symbols h4, with their parameter and return headings below them
        const sectionOf = (id: string) => page.locator(`xpath=//h4[@id="${id}"]/following-sibling::*[preceding-sibling::*[self::h2 or self::h3 or self::h4][1][@id="${id}"]]`)
        const wrappedLinks = new Set<string>()
        for (const entry of ["Effect", "js-ts"]) {
            await page.goto(`/docs/preview/api/modules/${entry}/#createclient`)
            await expect(page.locator("h4#createclient")).toHaveCount(1)
            const section = sectionOf("createclient")
            const details = section.filter({ has: page.getByText("Usage details", { exact: true }) })
            await expect(details).toHaveCount(1)
            await expect(details).not.toHaveAttribute("open", "")
            const blockquotes = section.and(page.locator("blockquote"))
            await expect(blockquotes).toHaveCount(2)
            // Short results stay on one line and link the entry point's own Client
            const result = blockquotes.last()
            await expect(result.locator("br")).toHaveCount(0)
            await expect(result.getByRole("link", { name: "Client", exact: true })).toHaveAttribute("href", `/docs/preview/api/interfaces/${entry}.Client/`)
            await page.screenshot({ path: info.outputPath(`${entry}-intro-${width}.png`), animations: "disabled" })
            await details.locator("summary").press("Enter")
            await expect(details).toHaveAttribute("open", "")
            await expect(details.locator("p").first()).toBeVisible()
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
            await details.scrollIntoViewIfNeeded()
            await page.screenshot({ path: info.outputPath(`${entry}-details-${width}.png`), animations: "disabled" })
            // Long generic results break at their outer type arguments, stay inside their box and keep their links
            for (const wrapped of await page.locator(".docs-content blockquote").filter({ has: page.locator("br") }).all()) {
                expect(await wrapped.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
                for (const href of await wrapped.locator('a[href^="/"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")!)))
                    wrappedLinks.add(href)
            }
        }
        expect(wrappedLinks.size).toBeGreaterThan(0)
        for (const href of wrappedLinks) await expectResolves(request, href)
    })
    test(`Reference generics and parameters stay compact at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto(clientPath)
        // Type parameters and parameters are tables below their member, not a heading per entry
        const layout = await page.locator(".docs-content").evaluate((content) => {
            const details = Array.from(content.querySelectorAll("h4")).filter((heading) => /^(Type Parameters|Parameters)$/.test(heading.textContent?.trim() ?? ""))
            return {
                deeperHeadings: content.querySelectorAll("h5, h6").length,
                kinds: [...new Set(details.map((heading) => heading.textContent?.trim()))],
                rows: details.map((heading) => heading.nextElementSibling?.tagName === "TABLE" ? heading.nextElementSibling.querySelectorAll("tbody tr").length : 0),
                codeBackgrounds: Array.from(content.querySelectorAll(":not(pre) > code")).map((code) => getComputedStyle(code).backgroundColor),
            }
        })
        expect(layout.deeperHeadings).toBe(0)
        expect(layout.kinds.sort()).toEqual(["Parameters", "Type Parameters"])
        expect(layout.rows.every((rows) => rows > 0)).toBe(true)
        expect(layout.codeBackgrounds.every((background) => background === "rgba(0, 0, 0, 0)")).toBe(true)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.locator('.docs-content h4[id^="type-parameters"]').first().scrollIntoViewIfNeeded()
        await page.screenshot({ path: info.outputPath(`client-generics-${width}.png`), animations: "disabled" })
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

/** The open preview's kind and name after hovering a trigger */
async function hoverPreview(page: Page, trigger: Locator) {
    await trigger.scrollIntoViewIfNeeded()
    await trigger.hover()
    const preview = page.locator(".reference-preview")
    await expect(preview).toBeVisible()
    return {
        preview,
        kind: (await preview.locator(".reference-preview-kind").textContent())!.trim(),
        name: (await preview.locator(".reference-preview-name").textContent())!.trim(),
    }
}

const inlineLink = (page: Page, href: string) =>
    page.locator(`.docs-content a[data-reference-link][href="${href}"]`).filter({ visible: true }).first()
const codeToken = (page: Page, reference: string, text: string) =>
    page.locator(`.docs-content pre .reference-token[data-reference="${reference}"]`).filter({ visible: true, hasText: text }).first()

test("Inline code in guides previews functions, variables and namespace members of the default API", async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/docs/preview/guilds-and-permissions/")
    const cases = [
        { href: "/docs/preview/api/modules/js-ts/#runbot", kind: "Function", name: "runBot" },
        { href: "/docs/preview/api/modules/js-ts/#channeltype", kind: "Variable", name: "ChannelType" },
        { href: "/docs/preview/api/interfaces/js-ts.ErrorTools/#apicode", kind: "Property", name: "ErrorTools.apiCode" },
        { href: "/docs/preview/api/interfaces/js-ts.DefaultGuards/#requirepermissions", kind: "Method", name: "DefaultGuards.requirePermissions" },
    ]
    for (const expected of cases) {
        const { preview, kind, name } = await hoverPreview(page, inlineLink(page, expected.href))
        expect({ kind, name }).toEqual({ kind: expected.kind, name: expected.name })
        await expect(preview.locator(".reference-preview-description")).not.toBeEmpty()
        await expect(preview.getByRole("link", { name: "Open reference", exact: true })).toHaveAttribute("href", new URL(expected.href, page.url()).href)
        if (expected.kind === "Property") await page.screenshot({ path: info.outputPath("inline-namespace-member-preview.png"), animations: "disabled" })
        await page.keyboard.press("Escape")
        await expect(preview).not.toBeVisible()
    }
    // Generated links are ordinary links, so keyboard focus previews them too
    const link = inlineLink(page, cases[0]!.href)
    await link.focus()
    await expect(page.locator(".reference-preview")).toBeVisible()
    await link.press("Enter")
    await expect(page).toHaveURL(atPath("/docs/preview/api/modules/js-ts/"))
})

test("Code block identifiers preview their public API in both APIs without links or tab stops", async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/docs/preview/small-bot/")
    const block = page.locator(".docs-content pre").filter({ has: page.locator(".reference-token") }).filter({ visible: true }).first()
    const before = await block.evaluate((node) => node.textContent)
    const reply = await hoverPreview(page, codeToken(page, "/docs/preview/api/interfaces/js-ts.DefaultPrefixCommandContext/#reply", "reply"))
    expect(reply).toMatchObject({ kind: "Property", name: "DefaultPrefixCommandContext.reply" })
    await expect(reply.preview.locator(".reference-preview-signature")).toContainText("reply")
    await page.screenshot({ path: info.outputPath("code-token-preview-default.png"), animations: "disabled" })
    const send = await hoverPreview(page, codeToken(page, "/docs/preview/api/interfaces/js-ts.Messages/#send", "send"))
    expect(send).toMatchObject({ kind: "Method", name: "Messages.send" })
    const runBot = await hoverPreview(page, codeToken(page, "/docs/preview/api/modules/js-ts/#runbot", "runBot"))
    expect(runBot).toMatchObject({ kind: "Function", name: "runBot" })
    await page.keyboard.press("Escape")
    await expect(runBot.preview).not.toBeVisible()
    // Tokens keep the code text and add no links or focus targets to the block
    expect(await block.evaluate((node) => node.textContent)).toBe(before)
    await expect(block.locator("a, [tabindex]:not(pre)")).toHaveCount(0)
    await page.goto("/docs/preview/effect-first-bot/")
    const effectSend = await hoverPreview(page, codeToken(page, "/docs/preview/api/interfaces/Effect.Messages/#send", "send"))
    expect(effectSend).toMatchObject({ kind: "Method", name: "Messages.send" })
    await expect(effectSend.preview.getByRole("link", { name: "Open reference", exact: true })).toHaveAttribute("href", /\/api\/interfaces\/Effect\.Messages\/#send$/)
    await page.screenshot({ path: info.outputPath("code-token-preview-effect.png"), animations: "disabled" })
    const inline = await hoverPreview(page, inlineLink(page, "/docs/preview/api/modules/Effect/#runbot"))
    expect(inline).toMatchObject({ kind: "Function", name: "runBot" })
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([])
})

test("Generated reference links work without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: "http://127.0.0.1:4322" })
    const page = await context.newPage()
    try {
        await page.goto("/docs/preview/guilds-and-permissions/")
        await expect(page.locator(".reference-preview")).toHaveCount(0)
        await inlineLink(page, "/docs/preview/api/interfaces/js-ts.ErrorTools/#apicode").click()
        await expect(page).toHaveURL(atPath("/docs/preview/api/interfaces/js-ts.ErrorTools/"))
        await expect(page.locator("#apicode")).toBeAttached()
    } finally {
        await context.close()
    }
})
