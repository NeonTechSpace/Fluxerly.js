import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { launchBrowser, screens, serveSite, tourKey } from "./lib.mjs"

// The public site built from made-up published versions, with the two things a real one needs from a Pages host read from its own files:
// each version's pages, links and search stay in that version, only the newest is open to search engines, and old addresses redirect.
// Usage: node scripts/checks/versions.mjs. Needs the generated content, so run after a build
// Astro moves files into its output, so the build stays on the project's own disk
await mkdir(".astro", { recursive: true })
const temporary = await mkdtemp(resolve(".astro/versions-"))
const released = join(temporary, "released")
const out = join(temporary, "dist")
const content = resolve("content")
const sourceCommit = "a".repeat(40)
const files = []
for (const entry of await readdir(content, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files.push({ path: relative(content, path).replaceAll("\\", "/"), content: await readFile(path, "utf8") })
}
const nightly = "1000.0.0-nightly.20261101.1"
const stable = "1000.1.0"
const older = "1000.0.0"
// Each version names the Fluxer commit its own snapshot was checked against: The older one gets another pin, and the newest keeps the generated one
const endpointsFile = files.find((file) => file.path === "reference/endpoints.json")
const generatedPin = JSON.parse(endpointsFile.content).source.fluxer.commit
const olderPin = "b".repeat(40)
const olderEndpoints = JSON.parse(endpointsFile.content)
olderEndpoints.source.fluxer.commit = olderPin
const filesOf = (version) => (version === older ? files.map((file) => (file === endpointsFile ? { ...file, content: JSON.stringify(olderEndpoints) } : file)) : files)
await mkdir(released, { recursive: true })
for (const version of [stable, older, nightly]) await writeFile(join(released, `${version}.json`), JSON.stringify({ schemaVersion: 3, version, sourceCommit, files: filesOf(version) }))
// npm's registry document for the made-up versions, with the older one deprecated, as npm marks one
const deprecation = "Upgrade to 1000.1.0 or newer"
const registry = join(temporary, "registry.json")
await writeFile(registry, JSON.stringify({ versions: { [stable]: {}, [nightly]: {}, [older]: { deprecated: deprecation } } }))

const problems = []
const expect = (ok, message) => ok || problems.push(message)
try {
    execFileSync(process.execPath, ["scripts/docs/build-public.mjs", "--released", released, "--out", out, "--registry", registry], { stdio: ["ignore", "pipe", "inherit"] })
    const read = (path) => readFile(join(out, path), "utf8")
    const newest = await read("docs/commands/index.html")
    const other = await read("docs/nightly/commands/index.html")
    expect(newest.includes('rel="canonical"') && !newest.includes('name="robots"'), "the newest version's pages must be open to search engines")
    expect(!other.includes('rel="canonical"') && other.includes('name="robots" content="noindex"'), "another version's pages must stay out of search results")
    expect(other.includes('href="/docs/nightly/quick-start/"') && !other.includes('href="/docs/quick-start/"'), "another version's links must stay in that version")
    expect((await read("docs/nightly/quick-start/index.html")).includes(`@neontechspace/fluxerly@${nightly}`), "another version's pages must install that version")
    expect(/docs\/commands\/<\/loc><changefreq>weekly</.test(await read("sitemap.xml")) && /neontechspace\.com\/commands\/<\/loc><changefreq>monthly</.test(await read("sitemap.xml")), "the sitemap must ask for the docs to be crawled more often than the other pages")
    expect(!(await read("sitemap.xml")).includes("/docs/nightly/"), "the sitemap must list only the newest version")
    expect((await read("_headers")).includes("/docs/nightly/*"), "another version's address must carry the noindex header")
    const olderPage = await read(`docs/${older}/commands/index.html`)
    expect(olderPage.includes('name="robots" content="noindex"'), "an older version's pages must stay out of search results")
    expect(olderPage.includes(`href="/docs/${older}/quick-start/"`), "an older version's links must stay in that version")
    expect((await read(`docs/${older}/quick-start/index.html`)).includes(`@neontechspace/fluxerly@${older}`), "an older version's pages must install that version")
    expect(/<summary[^>]*>\s*(?:<span class="sr-only"[^>]*>[^<]*<\/span>\s*)?<span class="version-label"[^>]*>[\s\S]*?1000\.0\.0/.test(olderPage), "an older version's pages must say which version they show")
    // The pin shows in the sidebar of every page and at the end of the overview, from the version's own snapshot
    const pinLink = (commit) => new RegExp(`<a href="https://github\\.com/fluxerapp/fluxer/commit/${commit}"[^>]*data-fluxer-pin="${commit}"[^>]*>\\s*${commit.slice(0, 7)}\\s*</a>`, "g")
    const pinCount = (page, commit) => page.match(pinLink(commit))?.length ?? 0
    expect(pinCount(newest, generatedPin) === 1 && pinCount(other, generatedPin) === 1, "the newest and nightly pages must name their snapshot's Fluxer commit once")
    expect(pinCount(olderPage, olderPin) === 1 && !olderPage.includes(generatedPin), "an older version's pages must name the Fluxer commit from its own snapshot, not today's")
    expect(pinCount(await read(`docs/${older}/index.html`), olderPin) === 2, "an older version's overview must name its Fluxer commit in the sidebar and in the page")
    expect(pinCount(await read("docs/index.html"), generatedPin) === 2, "the overview must name its Fluxer commit in the sidebar and in the page")
    expect(/version-list[\s\S]*Older Versions/.test(newest) && newest.includes(`data-docs-version="/docs/${older}/"`), "the newest pages must offer the older versions")
    // npm's deprecation shows in every version's menu and on the deprecated version's own pages, and nowhere else
    const menuEntry = (page, version) => new RegExp(`data-docs-version="/docs/${version.replaceAll(".", "\\.")}/"[^>]*>[\\s\\S]*?</a>`).exec(page)?.[0] ?? ""
    expect(menuEntry(newest, older).includes("version-deprecated") && menuEntry(other, older).includes("version-deprecated"), "the version menu must mark a version npm deprecated")
    expect(!/version-deprecated/.test(menuEntry(newest, "nightly")) && (newest.match(/class="version-deprecated"/g)?.length ?? 0) === 1, "the version menu must mark only the deprecated version")
    expect(olderPage.includes("version-note") && olderPage.includes(deprecation) && !newest.includes("version-note"), "a deprecated version's pages must say so with npm's message, and only its pages")
    expect(other.includes(`"https://fluxerly.neontechspace.com/docs/nightly/commands/`) && !other.includes(`"https://fluxerly.neontechspace.com/docs/commands/`), "another version's share address and structured data must name that version")
    expect((await read("docs/nightly/quick-start.md")).includes("https://fluxerly.neontechspace.com/docs/nightly/"), "another version's Markdown links must stay in that version")
    // The text files for AI tools: Every link is a full address, guides link to their Markdown, and the reference carries real signatures
    const reference = await read("docs/nightly/llms-reference.txt")
    const index = await read("docs/nightly/llms.txt")
    expect(index.includes("https://fluxerly.neontechspace.com/docs/nightly/quick-start.md"), "a version's llms.txt must list that version's Markdown")
    expect(index.includes(`https://fluxerly.neontechspace.com/docs/llms.txt`), "a version's llms.txt must name the other versions")
    expect(index.includes("https://fluxerly.neontechspace.com/docs/nightly/changelog/"), "a version's llms.txt must keep the docs menu's other links")
    expect(reference.includes("Page: https://fluxerly.neontechspace.com/docs/nightly/api/") && /^- `createClient<F extends .+>\(.+\): Client</m.test(reference), "the condensed reference must hold page links and signatures")
    expect(!/&(?:lt|gt|amp|quot);/.test(reference), "the condensed reference must be plain text, not HTML")
    expect(/#### interface TextChannelCreate[\s\S]*?- Inherits from `ChannelCreateBase`: [^\n]*`name`/.test(reference), "the condensed reference must name inherited members")
    expect(/^- \[`client\.connect`\]\(https:\/\/fluxerly\.neontechspace\.com\/docs\/nightly\/api\//m.test(await read("docs/nightly/api/tasks.md")), "the methods by task must link to the reference")
    expect(/\]\(https:\/\/fluxerly\.neontechspace\.com\/docs\/nightly\/[\w-]+\.md/.test(await read("docs/nightly/quick-start.md")) && !/\]\(\/docs\//.test(await read("docs/nightly/llms-full.txt")), "guide links must be full addresses to Markdown")
    // Each guide names its Markdown in its head, in its own version. Pages with no Markdown don't
    expect(newest.includes('<link rel="alternate" type="text/markdown" href="/docs/commands.md"'), "the newest version's guides must name their Markdown")
    expect(other.includes('<link rel="alternate" type="text/markdown" href="/docs/nightly/commands.md"'), "another version's guides must name their own Markdown")
    expect(!(await read("docs/changelog/index.html")).includes("data-copy-markdown"), "a page with no Markdown must not offer to copy it")
    // Every docs page leads to its version's index for AI tools, in its head for tools and in its menu for anyone reading the page as text
    for (const [name, page] of [["another version's guide", other], ["another version's reference page", await read("docs/nightly/api/index.html")]]) {
        expect(/<link rel="alternate" type="text\/plain" href="\/docs\/nightly\/llms\.txt"/.test(page), `${name} must name its version's llms.txt in its head`)
        expect(/<a [^>]*href="\/docs\/nightly\/llms\.txt"/.test(page), `${name} must link its version's llms.txt in its menu`)
    }
    expect(!index.includes("nightly/llms.txt"), "a version's llms.txt must not list itself")
    expect(!index.includes("## What Fluxerly includes") && (await read("llms.txt")).includes("https://fluxerly.neontechspace.com/raw/"), "only the newest version's llms.txt must list the feature pages")
    // Apps that show link previews skip a share picture they find too heavy
    const shareImage = /property="og:image" content="https:\/\/fluxerly\.neontechspace\.com\/([^"]+)"/.exec(newest)?.[1] ?? ""
    expect(shareImage && (await readFile(join(out, shareImage))).length < 300_000, "the share picture must exist and stay under 300 KB")
    for (const [name, page] of [["the newest guide", newest], ["another version's guide", other], ["the homepage", await read("index.html")], ["the 404 page", await read("404.html")]]) {
        expect(page.includes('<meta name="theme-color" content="#191478"'), `${name} must carry the blue-purple theme color`)
    }
    // Every icon file must be one the site can load: Named in the built pages, or in the hero's sky, which builds its names as it runs
    const builtText = await Promise.all((await readdir(out, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile() && /\.(html|js|css|json)$/.test(entry.name)).map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")))
    const skyIcons = [...(await readFile("src/scene/companion-specs.ts", "utf8")).matchAll(/slug: "([^"]+)"/g)].map((match) => match[1])
    for (const entry of await readdir(join(out, "art/icons"), { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const named = builtText.some((text) => text.includes(`/art/icons/${entry.name}`))
        expect(named || skyIcons.some((slug) => entry.name.startsWith(`${slug}-`)), `the icon file ${entry.name} is never used`)
    }
    const redirects = await read("_redirects")
    for (const line of ["/docs/latest/* /docs/:splat 302", "/docs/1000.1.0/* /docs/:splat 302"]) expect(redirects.includes(line), `missing redirect: ${line}`)
    expect((await read("docs/nightly/llms.txt")).includes(nightly) && (await read("llms.txt")).includes(stable), "the AI files must name their version")

    const site = await serveSite(out)
    const browser = await launchBrowser(site.url)
    const page = await browser.newPage()
    await page.goto(`${site.url}/docs/nightly/commands/`, { waitUntil: "load" })
    const links = page.locator(".version-list [data-docs-version]")
    expect((await links.count()) === 3, "the menu must offer each version")
    await page.locator(".version-menu summary").click()
    expect((await page.locator(".version-list [aria-current] .version-label").textContent()).trim() === "Nightly", "the menu must mark the version on screen")
    await links.first().click()
    await page.waitForURL(`${site.url}/docs/commands/`)
    await page.goto(`${site.url}/docs/nightly/commands/`, { waitUntil: "load" })
    const found = await page.evaluate(async () => {
        const pagefind = await import("/docs/nightly/pagefind/pagefind.js")
        await pagefind.options({ baseUrl: "/docs/nightly/" })
        await pagefind.init()
        const { results } = await pagefind.search("prefix command")
        return results.length ? (await results[0].data()).url : ""
    })
    expect(found.startsWith("/docs/nightly/"), `search in a version must stay in it, got ${found}`)
    // Copying a guide as Markdown gives that version's text
    {
        const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, permissions: ["clipboard-read", "clipboard-write"] })
        const copying = await context.newPage()
        await copying.goto(`${site.url}/docs/nightly/commands/`, { waitUntil: "load" })
        await copying.locator("[data-copy-markdown]").click()
        await copying.locator("[data-copy-markdown][data-copied]").waitFor({ timeout: 5000 }).catch(() => {})
        const copied = await copying.evaluate(() => navigator.clipboard.readText())
        expect(copied === (await read("docs/nightly/commands.md")), "Copy as Markdown must copy this version's Markdown")
        await context.close()
    }
    // Hover explanations work on another version's pages
    await page.goto(`${site.url}/docs/nightly/commands/`, { waitUntil: "load" })
    await page.locator('.docs-article a[href^="/docs/nightly/glossary/"], .docs-article [data-peek]').first().hover()
    expect(await page.locator(".peek").first().waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false), "a hover explanation must open on another version's pages")
    await page.locator('.docs-article a[href^="/docs/nightly/glossary/"]').first().hover()
    expect(await page.getByText("In the glossary").first().waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false), "a glossary hover on another version's pages must say it opens the glossary")
    await page.goto(`${site.url}/docs/commands/`, { waitUntil: "load" })
    await page.locator(".version-menu summary").click()
    await page.locator(`.version-list a[data-docs-version="/docs/${older}/"]`).click()
    await page.waitForURL(`${site.url}/docs/${older}/commands/`)
    expect((await page.locator(".version-menu summary .version-number").textContent()).trim() === older, "the menu must show the older version")
    // The version on screen looks chosen, not faded: An older version is its row's only word, and it is as bright as the row
    await page.locator(".version-menu summary").click()
    const looks = await page.evaluate(() => {
        const bright = (number) => getComputedStyle(number).color === getComputedStyle(number.parentElement).color && getComputedStyle(number).opacity === "1"
        const label = document.querySelector(".version-menu summary .version-label")
        return { listed: bright(document.querySelector(".version-list a[aria-current] .version-number")), summary: !label.hidden && label.getClientRects().length > 0 && bright(label) }
    })
    // The button's accessible name holds the words it shows, so speech input that says "Older Version" reaches it
    {
        const cdp = await page.context().newCDPSession(page)
        const { root } = await cdp.send("DOM.getDocument")
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".version-menu summary" })
        const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false })
        const spoken = String(nodes[0]?.name?.value ?? "").replace(/\s+/g, " ")
        const shown = await page.evaluate(() =>
            [...document.querySelectorAll(".version-menu summary :is(.version-label, .version-number, .version-deprecated)")]
                .filter((part) => part.getClientRects().length > 0)
                .map((part) => part.textContent.trim())
                .join(" "),
        )
        expect(shown.includes("Older Version") && shown.includes(older) && spoken.includes(shown), `the menu's button must be named with the words it shows: it shows "${shown}" and is named "${spoken}"`)
        await cdp.detach()
    }
    expect(looks.listed, "the menu's chosen older version must be as bright as its row, not faded")
    expect(looks.summary, "the menu's button must name an older version as brightly as Stable and Nightly")
    // Every version reads whole in the menu on every screen the screen check covers, a nightly's long number too, and the menu keeps its shape
    const cutAt = []
    for (const screen of screens) {
        const context = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, hasTouch: Boolean(screen.touch), isMobile: Boolean(screen.touch), deviceScaleFactor: screen.dpr ?? 1 })
        const small = await context.newPage()
        await small.addInitScript(([key]) => localStorage.setItem(key, "1"), [tourKey])
        await small.goto(`${site.url}/docs/nightly/commands/`, { waitUntil: "load" })
        const menuButton = small.locator(".side-open").first()
        if (await menuButton.isVisible()) await menuButton.click()
        await small.locator(".version-menu summary").click()
        const problem = await small.evaluate(() => {
            const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1
            const meets = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
            const menu = document.querySelector(".version-menu")
            for (const number of menu.querySelectorAll(".version-number")) {
                if (number.scrollWidth > number.clientWidth + 1 || !inside(number.getBoundingClientRect(), number.parentElement.getBoundingClientRect())) return `${number.textContent} is cut`
                const lines = document.createRange()
                lines.selectNodeContents(number)
                if (lines.getClientRects().length > 1) return `${number.textContent} is split across lines`
            }
            const summary = menu.querySelector("summary")
            const caret = summary.querySelector(".version-caret").getBoundingClientRect()
            if (!inside(caret, summary.getBoundingClientRect()) || [...summary.children].some((child) => !child.matches(".version-caret") && meets(child.getBoundingClientRect(), caret))) return "the caret overlaps the version"
            const list = menu.querySelector(".version-list").getBoundingClientRect()
            if (!inside(list, document.querySelector(".docs-side").getBoundingClientRect())) return "the list leaves the sidebar"
            // The open list lies over no row of the sidebar, which its edge would cut in half. A row scrolled out of the course's own
            // view counts only where that view shows it
            const view = document.querySelector(".course-scroll").getBoundingClientRect()
            for (const row of document.querySelectorAll(".docs-side :is(a, summary, button, p)")) {
                if (menu.contains(row)) continue
                const box = row.getBoundingClientRect()
                const seen = row.closest(".course-scroll") ? { left: box.left, right: box.right, top: Math.max(box.top, view.top), bottom: Math.min(box.bottom, view.bottom) } : box
                if (box.width > 0 && seen.bottom > seen.top && meets(seen, list)) return `the open list lies over ${row.textContent.trim().slice(0, 30)}`
            }
            return ""
        })
        if (problem) cutAt.push(`${screen.name}: ${problem}`)
        await context.close()
    }
    expect(!cutAt.length, `every version must read whole in the menu: ${cutAt.slice(0, 6).join(", ")}`)
    // A long list of versions scrolls inside the menu, doesn't move the page, and stays reachable on short and phone screens
    for (const [width, height, touch] of [[1366, 768, false], [1024, 500, false], [844, 390, true], [390, 844, true]]) {
        const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch })
        const small = await context.newPage()
        await small.addInitScript(([key]) => localStorage.setItem(key, "1"), [tourKey])
        await small.goto(`${site.url}/docs/commands/`, { waitUntil: "load" })
        // On a narrow screen the sidebar is a sheet behind this button
        const menuButton = small.locator(".side-open").first()
        if (await menuButton.isVisible()) await menuButton.click()
        await small.evaluate(() => {
            const list = document.querySelector(".version-list")
            const row = list.querySelector("a:last-of-type")
            for (let index = 0; index < 30; index++) list.append(row.cloneNode(true))
        })
        await small.locator(".version-menu summary").click()
        const result = await small.evaluate(async () => {
            const list = document.querySelector(".version-list")
            const page = scrollY
            list.scrollTop = list.scrollHeight
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
            const last = list.lastElementChild.getBoundingClientRect()
            return { scrolls: list.scrollHeight > list.clientHeight, moved: list.scrollTop > 0, bottom: list.getBoundingClientRect().bottom, last: last.bottom, page: scrollY - page, overscroll: getComputedStyle(list).overscrollBehaviorY, height: innerHeight }
        })
        const where = `${width}x${height}`
        expect(result.scrolls && result.moved, `the version list must scroll at ${where}`)
        expect(result.overscroll === "contain" && result.page === 0, `the version list's scroll must not move the page at ${where}`)
        expect(result.last <= result.bottom + 1, `the last version must be reachable at ${where}`)
        await context.close()
    }
    await browser.close()
    site.close()

    // Before the first Stable there's only Nightly, and npm's plain install wouldn't be what the homepage describes
    const nightlyOnly = join(temporary, "nightly-only")
    const nightlyOut = join(temporary, "nightly-out")
    await mkdir(nightlyOnly, { recursive: true })
    await writeFile(join(nightlyOnly, `${nightly}.json`), JSON.stringify({ schemaVersion: 3, version: nightly, sourceCommit, files }))
    execFileSync(process.execPath, ["scripts/docs/build-public.mjs", "--released", nightlyOnly, "--out", nightlyOut, "--registry", registry], { stdio: ["ignore", "pipe", "inherit"] })
    const home = await readFile(join(nightlyOut, "index.html"), "utf8")
    expect(home.includes("npm install --save-exact @neontechspace/fluxerly@nightly") && home.includes("npx @neontechspace/fluxerly@nightly init"), "with no Stable yet, the homepage must install the nightly")
    for (const path of ["index.html", "first-reply/index.html"]) {
        const words = (await readFile(join(nightlyOut, path), "utf8")).replace(/<[^>]+>/g, "")
        expect(!/@neontechspace\/fluxerly (?:init|$)/m.test(words), `with no Stable yet, ${path} must not offer an untagged command`)
    }
} finally {
    await rm(temporary, { recursive: true, force: true })
}
if (problems.length) {
    console.error(problems.join("\n"))
    process.exit(1)
}
console.log("Versions check passed")
