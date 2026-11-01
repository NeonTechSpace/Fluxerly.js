import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { launchBrowser, serveSite, tourKey } from "./lib.mjs"

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
await mkdir(released, { recursive: true })
for (const version of [stable, older, nightly]) await writeFile(join(released, `${version}.json`), JSON.stringify({ schemaVersion: 3, version, sourceCommit, files }))

const problems = []
const expect = (ok, message) => ok || problems.push(message)
try {
    execFileSync(process.execPath, ["scripts/docs/build-public.mjs", "--released", released, "--out", out], { stdio: ["ignore", "pipe", "inherit"] })
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
    expect(/<summary[^>]*>\s*<span class="version-label"[^>]*>[\s\S]*?1000\.0\.0/.test(olderPage), "an older version's pages must say which version they show")
    expect(/version-list[\s\S]*Older Versions/.test(newest) && newest.includes(`data-docs-version="/docs/${older}/"`), "the newest pages must offer the older versions")
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
    // Apps that show link previews skip a share picture they find too heavy
    const shareImage = /property="og:image" content="https:\/\/fluxerly\.neontechspace\.com\/([^"]+)"/.exec(newest)?.[1] ?? ""
    expect(shareImage && (await readFile(join(out, shareImage))).length < 300_000, "the share picture must exist and stay under 300 KB")
    for (const [name, page] of [["the newest guide", newest], ["another version's guide", other], ["the homepage", await read("index.html")], ["the 404 page", await read("404.html")]]) {
        expect(page.includes('<meta name="theme-color" content="#5b5ef2"'), `${name} must carry the blue-purple theme color`)
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
    execFileSync(process.execPath, ["scripts/docs/build-public.mjs", "--released", nightlyOnly, "--out", nightlyOut], { stdio: ["ignore", "pipe", "inherit"] })
    const home = await readFile(join(nightlyOut, "index.html"), "utf8")
    expect(home.includes("npm install @neontechspace/fluxerly@nightly") && home.includes("npx @neontechspace/fluxerly@nightly init"), "with no Stable yet, the homepage must install the nightly")
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
