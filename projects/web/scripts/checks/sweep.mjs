import { AsyncLocalStorage } from "node:async_hooks"
import { existsSync, globSync } from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import { resolve } from "node:path"
import { titleCase } from "../../src/lib/title-case.ts"
import { snapshotContent } from "../docs/snapshot-content.mjs"
import { channelTargets, validateSnapshot } from "../versions.js"
import { areasForChanges, baseFlag, changedPaths, repositoryRoot } from "./changed.mjs"
import { experienceKey, launchBrowser, screens, serveSite, skyIconsKey, tourKey } from "./lib.mjs"

// The whole site at every screen in lib.mjs: layout on each kind of page, the first visit's spotlight, menus, titles on
// every page, and icons over text while scrolling. Fails with a list of what it found. Usage:
// node scripts/checks/sweep.mjs [--quick] [--changed [--base=<commit>]] [--only=alive,questions,scroll,install,layout,docs,choice,tour,menus,pages,titles,parts,sky,noscript]
// --quick covers a few screens of each kind. --changed runs only the parts and pages the changed files can reach, as
// changed.mjs works them out, and --base=<commit> makes those the files changed since that commit. Reads the built site,
// so run it after a build
//
// The parts run side by side in one browser. Together they keep at most WORKERS pages busy, the same as one part alone
// did when they ran in turn, and a part that works one page at a time holds one of those places while it runs
const flags = process.argv.slice(2)
const quick = flags.includes("--quick")
const only = flags.find((flag) => flag.startsWith("--only="))?.slice(7).split(",")
// Every check part, longest first, so the long ones start first instead of finishing alone at the end. A misspelled name
// in --only would otherwise run nothing and report clean
const groups = ["alive", "questions", "scroll", "install", "layout", "docs", "choice", "tour", "menus", "pages", "titles", "parts", "sky", "noscript"]
const unknown = only?.find((part) => !groups.includes(part))
if (unknown !== undefined) {
    console.error(`Unknown screen check ${JSON.stringify(unknown)}. Known checks: ${groups.join(", ")}`)
    process.exit(1)
}
const started = Date.now()
const sizes = quick ? screens.filter((screen) => screen.quick) : screens
const routes = ["/", "/commands/", "/effect/", "/first-reply/", "/docs/", "/docs/commands/", "/docs/api/", "/docs/api/tasks/", "/docs/api/endpoints/", "/docs/codes/", "/does-not-exist/"]
// Every built page, and the missing page's own file
const builtPages = [
    ...globSync("**/index.html", { cwd: resolve("dist") }).map((file) => {
        const folder = file.split(/[\\/]/).slice(0, -1).join("/")
        return folder ? `/${folder}/` : "/"
    }),
    "/404.html",
]
// WORKERS overrides the default worker count, which is 80% of logical CPUs rounded down, with a minimum of one
const workers = Math.max(1, Number(process.env.WORKERS) || Math.floor(os.cpus().length * 0.8))

// The area of the site a page is in, as changed.mjs names them: home, docs, missing for a page the site doesn't have, or
// the page's own name, such as commands
const areaOf = (path) => {
    if (path === "/" || path === "/index.html") return "home"
    if (path.startsWith("/docs/")) return "docs"
    const name = path.split("/")[1]
    return existsSync(resolve("dist", name, "index.html")) ? name : "missing"
}
// With --changed, the areas the changed files reach. Without it, or when they reach everything, every page counts
let reach
if (flags.includes("--changed")) {
    let paths
    try {
        paths = changedPaths(repositoryRoot, baseFlag(flags))
    } catch (error) {
        // A base that a force push left out of the history can't say what changed, so every screen is tested instead
        console.log(`${error instanceof Error ? error.message : error}, so every part and page is tested`)
    }
    if (paths) {
        const { areas, reasons } = areasForChanges(paths, repositoryRoot)
        for (const reason of reasons) console.log(reason)
        if (areas !== "all") reach = areas
    }
}
const covers = (route) => !reach || reach.has(areaOf(route))

// On a public build, the Fluxer commit the version at /docs/ was checked against, picked from released/ the way
// build-public.mjs picks it. Only that build writes _redirects. Undefined for a build of the current source
async function publicPin() {
    if (!existsSync(resolve("dist/_redirects"))) return undefined
    const snapshots = await Promise.all(globSync("released/*.json").map(async (file) => validateSnapshot(JSON.parse(await readFile(file, "utf8")))))
    const newest = snapshots.find((snapshot) => snapshot.version === channelTargets(snapshots.map((snapshot) => snapshot.version))[0]?.version)
    const endpoints = newest?.files.find((file) => file.path === "reference/endpoints.json")
    if (!newest || !endpoints) throw new Error("A public build needs the published snapshots it was built from in released/")
    return JSON.parse(snapshotContent(newest, endpoints)).source.fluxer.commit
}

const blankPicture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
const found = new Map()
const report = (rule, where) => {
    if (!found.has(rule)) found.set(rule, new Set())
    found.get(rule).add(where)
}

// The places for busy pages that every part shares, handed out in the order asked for
let free = workers
const waiting = []
const lane = async (work) => {
    if (free > 0) free--
    else await new Promise((go) => waiting.push(go))
    try {
        return await work()
    } finally {
        const next = waiting.shift()
        if (next) next()
        else free++
    }
}
const inParallel = (jobs, work) => Promise.all(jobs.map((job) => lane(() => work(job))))

// Each part with the pages it opens, which say the areas a --changed run picks it for. A part that works one page at a
// time is serial and holds one place for its whole run
const parts = new Map()
const part = (name, pages, work) => {
    if (!groups.includes(name)) throw new Error(`The screen check ${name} is missing from the group list`)
    parts.set(name, { name, pages, work, areas: new Set(pages.map(areaOf)) })
}
const serial = (name, pages, work) => part(name, pages, (list) => lane(() => work(list)))

// Every context comes from here. A part that opens a page in an area its list leaves out fails, since --changed would
// skip it for a change there
const running = new AsyncLocalStorage()
const newContext = async (options) => {
    const context = await browsers[opened++ % browsers.length].newContext(options)
    const owner = running.getStore()
    context.on("request", (request) => {
        if (!owner || !request.isNavigationRequest() || request.frame().parentFrame()) return
        const url = new URL(request.url())
        if (url.origin === site.url && !owner.areas.has(areaOf(url.pathname))) report(`the ${owner.name} check opens a page its list leaves out: ${url.pathname}`, owner.name)
    })
    return context
}

const openPage = async ({ width, height, touch, dpr }, mode = "still", tour = false) => {
    // A phone's browser, with a coarse pointer, so the touch rules apply as they do on a device
    const context = await newContext({ viewport: { width, height }, hasTouch: Boolean(touch), isMobile: Boolean(touch), deviceScaleFactor: dpr ?? 1 })
    const page = await context.newPage()
    page.on("pageerror", (error) => report(`page error: ${error.message.slice(0, 120)}`, `${width}x${height}`))
    if (mode) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [experienceKey, mode])
    if (!tour) await page.addInitScript((key) => localStorage.setItem(key, "1"), tourKey)
    return { context, page }
}

// The waits below are for the state a check reads, never for a set time, since a busy machine can hold a page's frames and
// timers back for seconds. Two frames: The first runs the resize, scroll and style changes waiting for it, and by the second
// that frame has been drawn
const frames = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
// Two frames, then until every transition and timed animation under selector has ended. Endless ones and ones tied to the
// scroll never end, so they don't count
const calm = (page, selector = "html") =>
    page.evaluate(async (selector) => {
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
        const timed = document.querySelector(selector).getAnimations({ subtree: true }).filter((animation) => animation.playState === "running" && animation.timeline instanceof DocumentTimeline && animation.effect?.getTiming().iterations !== Infinity)
        await Promise.allSettled(timed.map((animation) => animation.finished))
    }, selector)
// In the page from its start, as an init script: whether the homepage's signal line has yet to be drawn again for the
// night's present size. Night.astro draws it at once the first time and then a while after the size last changed, so it is
// due from each resize until the line's viewBox is written again
function watchLine() {
    addEventListener("DOMContentLoaded", () => {
        const night = document.querySelector("[data-night]")
        const svg = night?.querySelector("[data-thread]")
        if (!svg) return
        let first = true
        // Night.astro's own observer was made first, so it has seen the same size by the time this one runs
        new ResizeObserver(() => {
            const box = night.getBoundingClientRect()
            window.lineDue = !first || svg.getAttribute("viewBox") !== `0 0 ${box.width} ${box.height}`
            first = false
        }).observe(night)
        new MutationObserver(() => (window.lineDue = false)).observe(svg, { attributes: true, attributeFilter: ["viewBox"] })
    })
}
// A page at rest: its fonts in, its islands that don't wait to be seen awake, its transitions over and its signal line drawn
const settle = async (page) => {
    await page.evaluate(() => document.fonts.ready.then(() => {}))
    await page.waitForFunction(() => !document.querySelector("astro-island[ssr]:not([client=visible])"), null, { timeout: 30000 })
    await calm(page)
    await page.waitForFunction(() => !window.lineDue, null, { timeout: 30000 })
}

// Runs in the page. Every rule here is one a reader would notice on that screen
function auditLayout(touch) {
    const problems = []
    const box = (element) => element.getBoundingClientRect()
    const name = (element) => element.className?.toString?.().split(" ").find((part) => part && !part.startsWith("astro")) || element.tagName?.toLowerCase()
    const shown = (element) => {
        const rect = box(element)
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.02
    }
    const touching = (a, b, margin = 2) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > margin && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > margin
    const width = document.documentElement.clientWidth
    const height = innerHeight
    const zoom = Number.parseFloat(getComputedStyle(document.body).zoom) || 1

    if (document.documentElement.scrollWidth > width + 1) {
        const wide = [...document.querySelectorAll("body *")].filter((element) => shown(element) && box(element).right > width + 1 && !element.closest("svg,canvas,.depth,.near,.motes,.field,.rays,.nebula,pre,table,.docs-night"))
        problems.push(`page scrolls sideways: ${wide.slice(0, 3).map(name).join(",") || "unknown"}`)
    }

    // A turning ring reaches its whole circle in time, whatever one moment shows
    const ring = document.querySelector("#neonflux .orbit")
    if (ring && shown(ring)) {
        const icon = ring.querySelector("img")?.offsetWidth ?? 0
        const center = { x: box(ring).left + box(ring).width / 2, y: box(ring).top + box(ring).height / 2 }
        const reach = ring.offsetWidth / 2 + icon / 2
        for (const element of document.querySelectorAll("#neonflux .head *, #neonflux .tabs, #neonflux .deck")) {
            const rect = box(element)
            if (rect.width === 0 || rect.height === 0) continue
            const nearX = Math.max(rect.left, Math.min(center.x, rect.right))
            const nearY = Math.max(rect.top, Math.min(center.y, rect.bottom))
            if (Math.hypot(nearX - center.x, nearY - center.y) < reach - 1) problems.push(`the NeonFlux ring reaches over ${name(element)}`)
        }
    }

    // The signal line never passes through a far body
    const thread = document.querySelector("[data-thread] path[d^='M']")
    if (thread) {
        // Where each sits on the page, since its plane is far from there at the top of the page
        const bodies = [...document.querySelectorAll(".far:not([data-clear])")].filter(shown).map((element) => {
            const holder = element.offsetParent.getBoundingClientRect()
            const top = holder.top + element.offsetTop * zoom
            return { left: box(element).left, right: box(element).right, top, bottom: top + box(element).height }
        })
        const origin = thread.ownerSVGElement.getBoundingClientRect()
        const length = thread.getTotalLength()
        for (let along = 0; along < length && bodies.length; along += 24) {
            const point = thread.getPointAtLength(along)
            const x = origin.left + point.x * zoom
            const y = origin.top + point.y * zoom
            if (bodies.some((body) => x > body.left && x < body.right && y > body.top && y < body.bottom)) {
                problems.push("the signal line passes through a far body")
                break
            }
        }
    }

    // A rich hero's orbits stay whole on the screen and off the words beside them
    for (const scope of document.querySelectorAll(".feature-hero .scope")) {
        if (!shown(scope)) continue
        // The rings themselves, since the picture around them has empty corners
        const rings = [...scope.querySelectorAll(".scope-ring")].map(box)
        if (!rings.length) continue
        const rect = { left: Math.min(...rings.map((ring) => ring.left)), right: Math.max(...rings.map((ring) => ring.right)), top: Math.min(...rings.map((ring) => ring.top)), bottom: Math.max(...rings.map((ring) => ring.bottom)) }
        if (rect.left < 0 || rect.right > width) problems.push("a feature page's orbits run off the screen")
        for (const words of document.querySelectorAll(".feature-hero .hero-text a, .feature-hero .hero-line, .feature-hero .page-title")) {
            if (shown(words) && touching(rect, box(words))) problems.push(`a feature page's orbits cross ${name(words)}`)
        }
    }

    const scrollsItself = (element) => {
        for (let parent = element; parent && parent !== document.body; parent = parent.parentElement) {
            if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(parent).overflowX)) return true
        }
        return false
    }
    for (const element of document.querySelectorAll("h1,h2,h3,h4,p,li,a,button,summary,label,td,th,dt,dd,figcaption")) {
        if (!shown(element) || !element.textContent?.trim() || element.closest(".skip-link,.sr-only,[aria-hidden=true]")) continue
        const rect = box(element)
        if ((rect.right > width + 1 || rect.left < -1) && !scrollsItself(element)) problems.push(`text past the edge: ${name(element)}`)
    }

    const header = document.querySelector("header")
    if (header && shown(header)) {
        const controls = [...header.querySelectorAll("a,button")].filter((element) => shown(element) && !element.closest(".mode-tip,.panel"))
        controls.forEach((control, index) => {
            const rect = box(control)
            if (rect.right > width + 1 || rect.left < -1) problems.push(`header control off screen: ${name(control)}`)
            for (const other of controls.slice(index + 1)) {
                if (!control.contains(other) && !other.contains(control) && touching(rect, box(other))) problems.push(`header controls collide: ${name(control)}, ${name(other)}`)
            }
        })
    }

    const hero = document.querySelector("[data-hero]")
    if (hero && header) {
        const heroBox = box(hero)
        const title = box(hero.querySelector(".wordmark"))
        const controls = [...hero.querySelectorAll(".control")].map(box)
        const npm = box(hero.querySelector("[data-waterline]"))
        const mascot = box(hero.querySelector("[data-mascot]"))
        const words = [title, ...[".tagline", ".subline"].map((selector) => hero.querySelector(selector)).filter((element) => element && shown(element)).map(box), ...controls, npm]
        const lowest = Math.max(...controls.map((control) => control.bottom))
        if (title.top < box(header).bottom - 6) problems.push("hero: title under the header")
        if (mascot.top < box(header).bottom - 34) problems.push("hero: hat under the header")
        if (lowest > box(hero.querySelector("[data-waterline] .coin")).top - 4 && npm.left < controls[0].right) problems.push("hero: buttons touch the npm row")
        if (words.some((rect) => touching(mascot, rect, 8))) problems.push("hero: mascot over the words")
        if (lowest > height) problems.push("hero: buttons below the first screen")
        if (npm.bottom > height + 1) problems.push("hero: npm row below the first screen")
        if (mascot.right > width + 1 || mascot.left < -1 || mascot.bottom > Math.max(heroBox.bottom, height) + 1) problems.push("hero: mascot cut off")
        if (heroBox.height < height - 2) problems.push("hero: shorter than the screen")
    }

    for (const intro of document.querySelectorAll(".split > .intro")) {
        if (!shown(intro) || getComputedStyle(intro).position !== "sticky") continue
        if (box(intro).height / zoom + (Number.parseFloat(getComputedStyle(intro).top) || 0) > height / zoom) problems.push("pinned heading taller than the screen")
    }

    for (const figure of document.querySelectorAll("section figure.companion")) {
        if (!shown(figure)) continue
        const image = box(figure.querySelector("img"))
        const section = figure.closest("section")
        for (const text of section.querySelectorAll("h1,h2,h3,p,li")) {
            if (figure.contains(text) || !shown(text)) continue
            const range = document.createRange()
            range.selectNodeContents(text)
            if ([...range.getClientRects()].some((line) => line.width > 2 && touching(image, line, 6))) problems.push(`icon over text: ${section.id || name(section)}`)
        }
    }

    // Text keeps clear of its box's top and bottom edges, however many lines it wraps to: a box of its own, such as a command chip,
    // button or pill, by 6 px, and a chip inside running text by 2 px. Only the text counts, not the buttons beside it
    const textRects = (element) => {
        const rects = []
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const range = document.createRange()
        while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim() || walker.currentNode.parentElement.closest(".sr-only")) continue
            range.selectNodeContents(walker.currentNode)
            rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0.5))
        }
        return rects
    }
    // A box's own text counts even when it escapes the box. A chip of inline code wraps, so only its first line's text counts
    const clearOfEdges = (element, edge, need, firstLineOnly = false) => {
        const inside = textRects(element).filter((rect) => !firstLineOnly || (rect.top >= edge.top - 1 && rect.bottom <= edge.bottom + 1))
        if (!inside.length) return
        const room = Math.min(Math.min(...inside.map((rect) => rect.top)) - edge.top, edge.bottom - Math.max(...inside.map((rect) => rect.bottom)))
        if (room < need * zoom - 0.05) problems.push(`text ${Math.round(room * 10) / 10} px from its box's edge: ${name(element)}`)
    }
    for (const element of document.querySelectorAll("[data-waterline] .chip-wrap > .chip, .cmd-chip, .control:not(.github), [data-menu] .option, .fr-tab[aria-selected=true], .pager-link, .side-open, .code-more")) {
        if (shown(element)) clearOfEdges(element, box(element), 6)
    }
    for (const element of document.querySelectorAll(".docs-prose :is(p, li) > code, .docs-prose a.peek > code, .inline-code, a.peek-level")) {
        if (shown(element) && element.getClientRects().length) clearOfEdges(element, element.getClientRects()[0], 2, true)
    }

    const title = document.querySelector(".docs-title")
    if (title && scrollY === 0) {
        if (header && box(title).top < box(header).bottom - 8) problems.push("docs: title under the header")
        if (box(title).top > height * 0.75) problems.push("docs: title low on the first screen")
    }

    for (const element of document.querySelectorAll("main *, header *, footer *")) {
        if (![...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()) || !shown(element) || element.closest("svg,.station,.log,[aria-hidden=true],.sr-only")) continue
        if (Number.parseFloat(getComputedStyle(element).fontSize) < 14.5) problems.push(`text under 15 px: ${name(element)}`)
    }

    if (touch) {
        for (const element of document.querySelectorAll("a,button,summary,select,input:not([type=radio]):not([type=checkbox]),[role=tab],label:has(input)")) {
            if (!shown(element) || element.closest(".skip-link,[hidden],p,.docs-prose li,.docs-prose td,.answer p,.peek-card,figcaption,.lead,.text,.caption,.more")) continue
            if (getComputedStyle(element).display === "inline" || element.matches(".peek,.entry-mark,.ref-mark,[class*=mark]")) continue
            const rect = box(element)
            let targetWidth = rect.width
            let targetHeight = rect.height
            for (const pseudo of ["::before", "::after"]) {
                const layer = getComputedStyle(element, pseudo)
                if (layer.content === "none" || layer.position !== "absolute") continue
                const outside = (value) => Math.max(0, -(Number.parseFloat(value) || 0))
                targetHeight = Math.max(targetHeight, rect.height + outside(layer.top) + outside(layer.bottom))
                targetWidth = Math.max(targetWidth, rect.width + outside(layer.left) + outside(layer.right))
            }
            if (targetHeight < 43.5 || targetWidth < 24) problems.push(`touch target small: ${name(element.parentElement)} > ${name(element)}`)
        }
    }
    return [...new Set(problems)]
}

part("layout", routes, async () => {
    // One page for each route and kind of device, resized through every screen, and a blank picture for each picture: they
    // have their sizes in the markup. Reloading every route for every screen was most of this check's time. The tour part
    // below still loads the homepage fresh on every screen
    const kinds = [...new Set(sizes.map((screen) => `${Boolean(screen.touch)}|${screen.dpr ?? 1}`))].map((kind) => sizes.filter((screen) => `${Boolean(screen.touch)}|${screen.dpr ?? 1}` === kind))
    await inParallel(
        routes.filter(covers).flatMap((route) => kinds.map((screens) => ({ route, screens }))),
        async ({ route, screens }) => {
            const { context, page } = await openPage(screens[0])
            await context.route(/\.(webp|png|jpg)(\?|$)/, (request) => request.fulfill({ contentType: "image/png", body: blankPicture }))
            await page.addInitScript(watchLine)
            await page.goto(site.url + route, { waitUntil: "load" })
            for (const screen of screens) {
                await page.setViewportSize({ width: screen.width, height: screen.height })
                await settle(page)
                for (const problem of await page.evaluate(auditLayout, Boolean(screen.touch))) report(problem, `${screen.name} ${route}`)
            }
            await context.close()
        },
    )
})

part("tour", ["/", "/docs/commands/", "/does-not-exist/"], async (entries) => {
    // A first visit on each screen: the tip shows, around the switch, whole on the screen and goes for good
    await inParallel(sizes, async (screen) => {
        const route = entries[sizes.indexOf(screen) % entries.length]
        const { context, page } = await openPage(screen, null, true)
        await context.route(/\.(webp|png|jpg)(\?|$)/, (request) => request.fulfill({ contentType: "image/png", body: blankPicture }))
        // The tip has nothing to do with the 3D sky, which on a machine without a graphics card can hold a huge screen for many seconds
        await page.addInitScript(() => {
            const getContext = HTMLCanvasElement.prototype.getContext
            HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
                return kind.includes("webgl") ? null : getContext.call(this, kind, ...rest)
            }
        })
        await page.goto(site.url + route, { waitUntil: "load" })
        const where = `${screen.name} ${route}`
        const shown = await page.waitForSelector(".tour[data-on]", { timeout: 15000 }).then(() => true, () => false)
        if (!shown) {
            report("first visit tip never showed", where)
            await context.close()
            return
        }
        // The dark and the card come in with a transition, so they are read where they come to rest
        await calm(page, ".tour")
        const problems = await page.evaluate(() => {
            const list = []
            const round = (value) => Math.round(value * 10) / 10
            const card = document.querySelector(".tour-card").getBoundingClientRect()
            if (card.left < 0 || card.top < 0 || card.right > innerWidth || card.bottom > innerHeight) list.push(`first visit tip off screen: ${round(card.left)},${round(card.top)} to ${round(card.right)},${round(card.bottom)} on ${innerWidth}x${innerHeight}`)
            const light = document.querySelector(".tour-light").getBoundingClientRect()
            const toggle = document.querySelector(".motion").getBoundingClientRect()
            if (light.left > toggle.left || light.right < toggle.right || light.top > toggle.top || light.bottom < toggle.bottom) list.push("first visit light misses the switch")
            const at = document.elementFromPoint(toggle.left + toggle.width / 2, toggle.top + toggle.height / 2)
            if (!at?.closest(".motion")) list.push("the switch can't be pressed through the first visit tip")
            return list
        })
        for (const problem of problems) report(problem, where)
        // A press anywhere puts it away
        await page.mouse.click(screen.width / 2, screen.height - 8)
        const gone = await page.waitForFunction(() => !document.querySelector(".tour:popover-open"), null, { timeout: 3000 }).then(() => true, () => false)
        if (!gone) report("first visit tip won't close", where)
        // The tip opens a set time after the page loads, so the page's clock is moved past that time instead of waited out
        await page.clock.install()
        await page.reload({ waitUntil: "load" })
        await page.clock.runFor(5000)
        if (await page.evaluate(() => Boolean(document.querySelector(".tour:popover-open")))) report("first visit tip came back", where)
        await context.close()
    })
})

part("parts", ["/", "/commands/", "/effect/", "/first-reply/", "/testing/", "/production/", "/data/", "/results/", "/logs/", "/raw/"], async (pages) => {
    // A multi-part icon at rest, with its shadow, must look like the whole picture it takes over from, on the page, not only on its own
    const screen = sizes.find((candidate) => !candidate.touch && candidate.width >= 1280) ?? sizes[0]
    await inParallel(pages.filter(covers), async (route) => {
        const { context, page } = await openPage(screen, "immersive")
        await page.goto(site.url + route, { waitUntil: "load" })
        await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important} .glow{visibility:hidden!important}" })
        for (const figure of await page.$$(".companion[data-parts]")) {
            await figure.scrollIntoViewIfNeeded()
            const live = await figure.evaluate((element) => new Promise((done) => {
                const started = Date.now()
                const look = () => (element.dataset.live !== undefined ? done(true) : Date.now() - started > 8000 ? done(false) : setTimeout(look, 50))
                look()
            }))
            const name = await figure.evaluate((element) => element.querySelector(".part")?.dataset.src?.split("/").at(-2) ?? "?")
            if (!live) {
                report("a moving icon never took over", `${route} ${name}`)
                continue
            }
            // Each picture shown is whole and drawn before it is taken
            const drawn = () => figure.evaluate((element) => Promise.all([...element.querySelectorAll("img")].map((picture) => picture.decode().catch(() => {})))).then(() => frames(page))
            await drawn()
            const box = await figure.boundingBox()
            if (!box) continue
            const clip = { x: Math.max(0, box.x - box.width * 0.3), y: Math.max(0, box.y - box.height * 0.3), width: box.width * 1.6, height: box.height * 1.6 }
            const parts = await page.screenshot({ clip })
            await figure.evaluate((element) => delete element.dataset.live)
            await drawn()
            const whole = await page.screenshot({ clip })
            await figure.evaluate((element) => (element.dataset.live = ""))
            const sharp = (await import("sharp")).default
            // Soft focus, so a browser smoothing thin edges its own way doesn't count, and a wrong shadow or a shifted part still does
            const [a, b] = await Promise.all([sharp(parts).removeAlpha().blur(2).raw().toBuffer(), sharp(whole).removeAlpha().blur(2).raw().toBuffer()])
            let total = 0
            for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i])
            const mean = total / a.length
            if (mean > 2) report(`a moving icon doesn't match its whole picture at rest: ${mean.toFixed(1)} levels`, `${route} ${name}`)
        }
        await context.close()
    })
})

part("install", ["/"], async () => {
    // Where the menu comes to rest. A menu lifted out of the hero scrolls the page and is placed again on the scroll event,
    // which fires with the next frame, and a busy machine can hold that frame back for seconds. So this waits for a frame
    // and then for the menu's transitions to end, instead of for a set time
    const settled = (page) =>
        page.evaluate(async () => {
            await new Promise((done) => requestAnimationFrame(() => done()))
            await Promise.allSettled(document.querySelector("[data-menu]").getAnimations({ subtree: true }).map((animation) => animation.finished))
        })
    // A press sent in the page. A tap waits for frames, which a busy machine can hold back for longer than any set limit.
    // Whether a finger can reach each option is part of the audit below
    const press = (page, selector) => page.$eval(selector, (element) => element.click())

    // The hero's install menu, open: every option on the screen, inside the hero, under the finger and big enough for it
    await inParallel(sizes, async (screen) => {
        const { context, page } = await openPage(screen)
        await context.route(/\.(webp|png|jpg)(\?|$)/, (request) => request.fulfill({ contentType: "image/png", body: blankPicture }))
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        const top = await page.evaluate(() => scrollY)
        await press(page, "[data-waterline] .pick")
        // Still, which this check runs in, opens the menu at once
        if (await page.evaluate(() => document.querySelector("[data-menu]").getAnimations().length)) report("the install menu moves as it opens in Still", screen.name)
        await settled(page)
        // The first screen keeps room for the menu under, over or beside the box, so opening it leaves the page and its
        // header where they are
        const moved = (await page.evaluate(() => scrollY)) - top
        if (moved) report(`opening the install menu scrolls the page ${Math.round(moved)} px`, screen.name)
        const audit = (touch) => {
            const list = []
            const hero = document.querySelector("[data-hero]").getBoundingClientRect()
            const menu = document.querySelector("[data-menu]").getBoundingClientRect()
            const chip = document.querySelector("[data-waterline] .chip").getBoundingClientRect()
            const groups = [...document.querySelectorAll("[data-menu] .menu-row")].map((group) => group.getBoundingClientRect())
            const divider = document.querySelector("[data-menu] .menu-divider")
            if (groups[0].top !== groups[1].top && getComputedStyle(divider).display !== "none") list.push("install menu: a divider with nothing to divide")
            // Beside the box and level with it where there's room, otherwise right under or over it
            // The page's zoom on wide screens scales the gap too
            const reach = 12 * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--page-zoom")) || 1)
            const beside = Math.abs(menu.bottom - chip.bottom) < 2 && menu.left >= chip.right && menu.left - chip.right < reach
            const above = menu.right > chip.left && menu.left < chip.right
            const touching = above && (Math.abs(menu.top - chip.bottom) < reach || Math.abs(chip.top - menu.bottom) < reach)
            if (!beside && !touching) list.push("install menu: detached from the install box")
            // Nor does it cover the hero's other controls, such as Get Started, Explore and GitHub
            for (const control of document.querySelectorAll("[data-hero] :is(a, button)")) {
                const box = control.getBoundingClientRect()
                if (control.closest("[data-waterline]") || !box.width) continue
                if (box.bottom > menu.top && box.top < menu.bottom && box.right > menu.left && box.left < menu.right) list.push(`install menu: covers ${control.textContent.trim() || control.getAttribute("aria-label")}`)
            }
            for (const button of document.querySelectorAll("[data-waterline] .chip-wrap .tool-button")) {
                const box = button.getBoundingClientRect()
                if (document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".tool-button") !== button) list.push("install menu: covers the install box's buttons")
            }
            // Wrapped rows keep their reach for a finger apart, so a tap can't land on the wrong row
            const [upper, lower] = [...document.querySelectorAll("[data-menu] .menu-row")].map((group) => group.querySelector(".option").getBoundingClientRect())
            if (touch && lower.top > upper.top && lower.top - upper.bottom < 16) list.push("install menu: the wrapped rows' reach overlaps")
            for (const option of document.querySelectorAll("[data-menu] .option")) {
                const box = option.getBoundingClientRect()
                const name = option.textContent.trim()
                // A menu lifted onto the top layer is clipped only by the window
                const lifted = document.querySelector("[data-menu]").matches(":popover-open")
                const [top, bottom] = lifted ? [0, innerHeight] : [Math.max(0, hero.top), Math.min(innerHeight, hero.bottom)]
                if (box.left < 0 || box.right > innerWidth || box.top < top || box.bottom > bottom) list.push(`install menu: ${name} is cut off`)
                else if (document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".option") !== option) list.push(`install menu: ${name} can't be pressed`)
                if (touch) {
                    const before = getComputedStyle(option, "::before")
                    const reach = before.content === "none" ? box.height : box.height - parseFloat(before.top) - parseFloat(before.bottom)
                    if (reach < 43.5) list.push("install menu: an option under 44 px")
                }
            }
            return list
        }
        for (const problem of await page.evaluate(audit, Boolean(screen.touch))) report(problem, screen.name)
        // A command of another length moves the box, and the menu has to stay whole
        for (const command of ["init", "install"]) {
            await press(page, `[data-menu] [data-group="mode"] [data-value="${command}"]`)
            await settled(page)
            for (const problem of await page.evaluate(audit, Boolean(screen.touch))) report(problem, `${screen.name} ${command}`)
            // Closed and opened again with that command, and the next one picked from there
            await press(page, "[data-waterline] .pick")
            await press(page, "[data-waterline] .pick")
            await settled(page)
            for (const problem of await page.evaluate(audit, Boolean(screen.touch))) report(problem, `${screen.name} ${command}, reopened`)
        }
        await context.close()
    })

    // A browser without popovers, such as Safari before 17, still opens and closes the install menu, even on a phone where
    // a newer browser lifts it out of the hero
    for (const screen of sizes.filter((candidate) => ["phone-320", "phone-390", "desktop-1920"].includes(candidate.name))) {
        const { context, page } = await openPage(screen)
        await page.addInitScript(() => {
            for (const name of ["showPopover", "hidePopover", "togglePopover", "popover"]) delete HTMLElement.prototype[name]
            const matches = Element.prototype.matches
            Element.prototype.matches = function (selector) {
                if (selector.includes(":popover-open")) throw new DOMException(`'${selector}' is not a valid selector`, "SyntaxError")
                return matches.call(this, selector)
            }
        })
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        const state = () => page.evaluate(() => ({ hidden: document.querySelector("[data-menu]").hidden, expanded: document.querySelector("[data-waterline] .pick").getAttribute("aria-expanded") }))
        await press(page, "[data-waterline] .pick")
        const opened = await state()
        if (opened.hidden || opened.expanded !== "true") report("without popovers the install menu doesn't open", screen.name)
        await press(page, "[data-waterline] .pick")
        const closed = await state()
        if (!closed.hidden || closed.expanded !== "false") report("without popovers the install menu doesn't close", screen.name)
        await context.close()
    }
})

part("menus", ["/docs/commands/"], async () => {
    await inParallel(sizes, async (screen) => {
        const { context, page } = await openPage(screen)
        await page.goto(`${site.url}/docs/commands/`, { waitUntil: "load" })
        await page.waitForFunction(() => !document.querySelector("astro-island[ssr]"), null, { timeout: 15000 })
        const trigger = await page.$("header .trigger")
        if (trigger && (await trigger.isVisible())) {
            await trigger.click({ force: true })
            // A click opens the menu at once, and it is read where its way in ends
            await calm(page)
            const problem = await page.evaluate(() => {
                const panel = [...document.querySelectorAll("header .panel")].find((element) => element.getBoundingClientRect().width > 0)
                if (!panel) return "did not open"
                const rect = panel.getBoundingClientRect()
                return rect.right > innerWidth + 1 || rect.left < -1 ? "off screen" : ""
            })
            if (problem) report(`Discover menu ${problem}`, screen.name)
            await page.keyboard.press("Escape")
            // Escape closes the menu as the key goes down, so only its way out is left to end
            await calm(page)
        } else report("Discover button missing", screen.name)
        await page.keyboard.press("Control+k")
        // The search box, once it shows and its dialog has come to rest. One that never shows is reported below
        const searchBox = () => [...document.querySelectorAll("input")].find((element) => element.offsetWidth > 0 && /search/i.test(`${element.placeholder}${element.type}${element.getAttribute("aria-label") ?? ""}`))
        if (await page.waitForFunction(searchBox, null, { timeout: 15000 }).then(() => true, () => false)) await calm(page)
        const search = await (await page.evaluateHandle(searchBox)).evaluate((input) => {
            if (!input) return "did not open"
            const rect = input.getBoundingClientRect()
            return rect.right > innerWidth + 1 || rect.left < -1 || rect.top < -1 || rect.bottom > innerHeight + 1 ? "off screen" : ""
        })
        if (search) report(`search ${search}`, screen.name)
        await context.close()
    })
})

part("titles", builtPages, async (pages) => {
    const { context: titleContext } = await openPage({ width: 1440, height: 900 })
    await titleContext.route(/\.(webp|png|jpg)(\?|$)/, (request) => request.fulfill({ contentType: "image/png", body: blankPicture }))
    await inParallel(pages.filter(covers), async (route) => {
        const page = await titleContext.newPage()
        await page.goto(site.url + route, { waitUntil: "domcontentloaded" })
        const titles = await page.evaluate(() => {
            const seen = new Set()
            for (const element of document.querySelectorAll("h1,h2,h3,h4,nav a,.control,.go-link,.nav-item,.trigger,.next-title,.pager-title,.part-tab,.station-head,.course-list a,.toc-list a,.outline-title,summary,.side-open,.search-open,.way,.fr-tab")) {
                if (element.closest("pre,.mode-tip,header .panel a") || element.matches(".next-link")) continue
                let text = ""
                for (const node of element.childNodes) {
                    if (node.nodeType === 3) text += node.textContent
                    else if (node.tagName === "CODE") text += " \u0000 "
                    else if (node.tagName !== "svg" && !node.matches?.(".sr-only,.anchor,[aria-hidden=true]")) text += node.textContent
                }
                text = text.trim().replace(/\s+/g, " ").replace(/#$/, "").trim()
                if (text.length > 2) seen.add(text)
            }
            return [...seen]
        })
        for (const title of titles) {
            // A single lower case word is a name from the code, such as an option, and keeps its spelling
            if (/^[a-z_][\w.-]*$/.test(title) || /[{}()<>=]/.test(title)) continue
            const parts = title.split(" \u0000 ")
            const cased = parts.map((part, index) => titleCase(part, { first: index === 0, last: index === parts.length - 1 })).join(" \u0000 ")
            if (cased !== title) report(`not in Title Case: ${title.replaceAll("\u0000", "code")}`, route)
        }
        await page.close()
    })
    await titleContext.close()
})

part("scroll", ["/", "/commands/"], async (pages) => {
    // Scrolling a whole page in motion is slow, and icons pass the words the same way on neighboring sizes, so a spread will do
    const wide = sizes.filter((screen) => screen.width >= 900).filter((screen, index) => quick || index % 3 === 0)
    await inParallel(
        wide.flatMap((screen) => pages.filter(covers).map((route) => ({ screen, route }))),
        async ({ screen, route }) => {
            const { context, page } = await openPage(screen, "immersive")
            await page.goto(site.url + route, { waitUntil: "load" })
            await settle(page)
            const problems = await page.evaluate(async () => {
                const list = new Set()
                document.documentElement.style.scrollBehavior = "auto"
                const figures = [...document.querySelectorAll("section figure.companion")]
                for (let y = 0; y < document.documentElement.scrollHeight; y += Math.round(innerHeight / 2)) {
                    window.scrollTo(0, y)
                    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
                    for (const figure of figures) {
                        const image = figure.querySelector("img").getBoundingClientRect()
                        if (image.bottom < 0 || image.top > innerHeight || image.width === 0) continue
                        for (const text of figure.closest("section").querySelectorAll("h1,h2,h3,p,li")) {
                            if (figure.contains(text)) continue
                            const range = document.createRange()
                            range.selectNodeContents(text)
                            const hit = [...range.getClientRects()].some((line) => line.width > 2 && Math.min(image.right, line.right) - Math.max(image.left, line.left) > 6 && Math.min(image.bottom, line.bottom) - Math.max(image.top, line.top) > 6)
                            if (hit) list.add(`icon over text while scrolling: ${figure.closest("section").id}`)
                        }
                    }
                }
                return [...list]
            })
            for (const problem of problems) report(problem, `${screen.name} ${route}`)
            await context.close()
        },
    )
})

serial("alive", ["/", "/commands/", "/docs/"], async () => {
    const screen = sizes.find((candidate) => !candidate.touch && candidate.width >= 1280) ?? sizes[0]
    const sharp = (await import("sharp")).default

    // The logo's waves roll by themselves while the site moves, and rest in Still
    for (const [mode, moves] of [["immersive", true], ["still", false]]) {
        const { context, page } = await openPage(screen, mode)
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        // Asked of the animation itself, not of two readings in time, since the 3D sky's start can hold the page up for a moment
        const running = await page.evaluate(() => document.querySelector(".home-waves").getAnimations().filter((animation) => animation.playState === "running").length)
        if (Boolean(running) !== moves) report(moves ? "the logo's waves don't move by themselves" : "the logo's waves move in Still", mode)
        await context.close()
    }

    // The docs' water moves by itself and never follows the page's scroll, and rests in Still. No script draws it
    for (const [mode, moves] of [["immersive", true], ["still", false]]) {
        const { context, page } = await openPage(screen, mode)
        await page.goto(`${site.url}/docs/commands/`, { waitUntil: "load" })
        const night = await page.evaluate(() => {
            const box = document.querySelector("[data-night]")
            const running = box.getAnimations({ subtree: true })
            return { running: running.length, tied: running.filter((animation) => !(animation.timeline instanceof DocumentTimeline)).length, canvases: box.querySelectorAll("canvas").length, bubbles: running.filter((animation) => animation.effect.target.matches(".docs-bubble")).length }
        })
        if (Boolean(night.running) !== moves) report(moves ? "the docs' water doesn't move" : "the docs' water moves in Still", mode)
        if (night.tied) report("something in the docs' background follows the scroll", mode)
        if (night.canvases) report("the docs' background draws on a canvas, which costs the page work on every frame", mode)
        if (moves && !night.bubbles) report("the docs' water has no crystal bubbles", mode)
        await context.close()
    }

    // The water carries on across a page change instead of starting over: from one page to the next, it has moved on by exactly the
    // time between them, whichever page it is on
    {
        const { context, page } = await openPage(screen, "immersive")
        const reading = () => page.evaluate(() => {
            const [sway] = document.querySelector(".ray-b").getAnimations()
            return { water: sway.currentTime - sway.effect.getTiming().delay, at: Date.now() }
        })
        await page.goto(`${site.url}/docs/commands/`, { waitUntil: "load" })
        const before = await reading()
        // About time itself: The water has to run a while for a restart to show, and a longer wait on a busy machine only makes
        // a restart plainer, since the reading compares the water with the page's own clock
        await page.waitForTimeout(3000)
        await page.goto(`${site.url}/docs/messages/`, { waitUntil: "load" })
        const after = await reading()
        const off = after.water - before.water - (after.at - before.at)
        if (Math.abs(off) > 1000) report(`the docs' water doesn't carry on across a page change: ${Math.round(off)} ms off`, "/docs/messages/")
        await context.close()
    }

    // Back and Forward return the reader to where they were, with the header as it was
    {
        const { context, page } = await openPage(screen, "immersive")
        await page.goto(`${site.url}/docs/create-a-bot/`, { waitUntil: "load" })
        await page.locator('.docs-side a[href*="/docs/quick-start"]').first().click()
        await page.waitForURL("**/docs/quick-start/")
        await page.goBack({ waitUntil: "load" })
        await page.goForward({ waitUntil: "load" })
        // The scroll the browser restores and the header's answer to it have both run after two frames
        await frames(page)
        const place = await page.evaluate(() => ({ y: scrollY, hidden: document.querySelector(".site-header").hasAttribute("data-hidden") }))
        if (place.y !== 0 || place.hidden) report(`Forward lands at ${Math.round(place.y)} px with the header ${place.hidden ? "hidden" : "shown"}, not where the reader left`, "/docs/quick-start/")
        await context.close()
    }

    // The header goes after one scroll down, on any kind of page, and comes back on the way up
    for (const route of ["/", "/commands/", "/docs/commands/"]) {
        const { context, page } = await openPage(screen, "immersive")
        await page.goto(site.url + route, { waitUntil: "load" })
        await page.mouse.move(screen.width / 2, screen.height / 2)
        // Waits for the state itself, up to well past any hold-up from the 3D sky's start, so a slow frame can't fail it
        const reaches = (hidden) => page.waitForFunction((want) => document.querySelector(".site-header").hasAttribute("data-hidden") === want, hidden, { timeout: 15000 }).then(() => true, () => false)
        await page.mouse.wheel(0, 100)
        if (!(await reaches(true))) report("the header stays after the first scroll down", route)
        await page.mouse.wheel(0, -60)
        if (!(await reaches(false))) report("the header doesn't come back on the way up", route)
        await context.close()
    }

    // The focus a click leaves on the motion switch lets the header go. Keyboard focus keeps it
    {
        const { context, page } = await openPage(screen, "immersive")
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        const header = page.locator(".site-header")
        const motion = header.locator(".motion[data-ready]")
        const hidden = (want) => page.waitForFunction((value) => document.querySelector(".site-header").hasAttribute("data-hidden") === value, want, { timeout: 15000 }).then(() => true, () => false)
        await motion.click()
        await page.mouse.move(screen.width / 2, screen.height / 2)
        await page.mouse.wheel(0, 100)
        if (!(await hidden(true))) report("the header stays after clicking the motion switch and scrolling down", "/")
        // A fresh page for the keyboard, because the header hiding took the focus off the switch
        await page.reload({ waitUntil: "load" })
        await motion.waitFor()
        // A reload can restore the old position, so the page starts from the top before the keyboard moves
        await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }))
        await page.waitForFunction(() => scrollY === 0)
        for (let press = 0; press < 20 && !(await motion.evaluate((element) => element === document.activeElement)); press += 1) await page.keyboard.press("Tab")
        if (!(await motion.evaluate((element) => element === document.activeElement && element.matches(":focus-visible")))) report("the motion switch can't be reached with the keyboard", "/")
        await page.mouse.move(screen.width / 2, screen.height / 2)
        await page.mouse.wheel(0, 100)
        await page.waitForFunction(() => scrollY > 12)
        // The scroll event and the frame that handles it have both run after two more frames
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
        if (await header.evaluate((element) => element.hasAttribute("data-hidden"))) report("the header leaves while the keyboard is on the motion switch", "/")
        await context.close()
    }

    // A long code block starts short, opens and closes with its button, and copies whole. A line never frames a thing from both sides
    {
        const { context, page } = await openPage(screen, "still")
        await context.grantPermissions(["clipboard-read", "clipboard-write"])
        await page.goto(`${site.url}/docs/examples/`, { waitUntil: "load" })
        const button = page.locator(".code-more:visible").first()
        const frame = button.locator("xpath=ancestor::figure")
        const height = async () => (await frame.boundingBox()).height
        const closed = await height()
        if (closed > 700) report(`a long code block starts ${Math.round(closed)} px tall`, "/docs/examples/")
        await button.click()
        const opened = await height()
        if (opened < closed + 300) report("a long code block's button doesn't open it", "/docs/examples/")
        await button.click()
        if (Math.abs((await height()) - closed) > 1) report("a long code block's button doesn't close it", "/docs/examples/")
        const lines = Number((await button.textContent()).match(/\d+/)?.[0])
        await frame.locator("[data-copy]").click()
        const copied = await page.evaluate(() => navigator.clipboard.readText())
        if (copied.split("\n").length !== lines) report(`copying a long code block gave ${copied.split("\n").length} of its ${lines} lines`, "/docs/examples/")
        if (/Show All|Show Less/.test(copied)) report("copying a long code block includes its button", "/docs/examples/")
        await context.close()
    }
    for (const route of ["/docs/examples/", "/docs/logging/", "/docs/api/tasks/"]) {
        const { context, page } = await openPage(screen, "still")
        await page.goto(site.url + route, { waitUntil: "load" })
        const framed = await page.evaluate(() =>
            [...document.querySelectorAll(".docs-main *")].filter((element) => {
                const style = getComputedStyle(element)
                return !element.closest("table") && element.getBoundingClientRect().height > 20 && parseFloat(style.borderTopWidth) >= 1 && parseFloat(style.borderBottomWidth) >= 1 && style.borderTopStyle !== "none" && style.borderBottomStyle !== "none" && style.borderTopColor !== "rgba(0, 0, 0, 0)" && style.borderBottomColor !== "rgba(0, 0, 0, 0)"
            }).map((element) => element.className),
        )
        for (const name of new Set(framed)) report(`two lines frame one thing: ${name}`, route)
        await context.close()
    }

    // A page change is a plain change. The browser's own page transitions went blank for their whole length about one time in three
    {
        const { context, page } = await openPage(screen, "immersive")
        await page.addInitScript(() => addEventListener("pagereveal", (event) => (window.revealedWithTransition = Boolean(event.viewTransition))))
        await page.goto(`${site.url}/docs/commands/`, { waitUntil: "load" })
        await page.locator('.docs-side a[href*="/docs/messages"]').first().click()
        await page.waitForURL("**/docs/messages/")
        if (await page.evaluate(() => window.revealedWithTransition)) report("a page change uses the browser's page transition, which can go blank", "/docs/messages/")
        await context.close()
    }

    // No code block anywhere in the docs is long and uncut, and its two languages are cut alike
    for (const route of ["/docs/api/effect-testing/testing/", "/docs/api/effect/client-and-lifecycle/", "/docs/logging/", "/docs/examples/"]) {
        const { context, page } = await openPage(screen, "still")
        await page.goto(site.url + route, { waitUntil: "load" })
        const result = await page.evaluate(() => ({
            uncut: [...document.querySelectorAll(".docs-main pre")].filter((pre) => pre.querySelectorAll(".line").length > 28 && !pre.querySelector(".code-rest")).length,
            uneven: [...document.querySelectorAll(".code-frame")].filter((frame) => new Set([...frame.querySelectorAll("[data-copy-text]")].map((variant) => Boolean(variant.querySelector(".code-rest")))).size > 1).length,
        }))
        if (result.uncut) report(`${result.uncut} long code blocks aren't cut`, route)
        if (result.uneven) report(`${result.uneven} code blocks are cut in one language only`, route)
        await context.close()
    }

    // With every picture still on its way the hero already has its words, its install row and the conductor's preview
    {
        const { context, page } = await openPage(screen, "immersive")
        await context.route(/\.(webp|png|jpg)(\?|$)/, () => {})
        await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" })
        const hero = await page.evaluate(() => {
            const seen = (selector) => {
                const element = document.querySelector(selector)
                return element && element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
            }
            return { words: seen("[data-hero-text]"), install: seen("[data-waterline]"), preview: getComputedStyle(document.querySelector("[data-conductor]"), "::before").opacity === "1" }
        })
        for (const [part, there] of Object.entries(hero)) if (!there) report(`the hero holds back its ${part} until the pictures come`, "/")
        await context.close()
    }

    // A click right after hovering opened the Discover menu is a reflex and leaves it open. A later click closes it. The
    // page's clock stands still between the steps, so a slow machine can't turn the reflex click into a later one. It
    // starts at a set time and stops two load limits later, so however slow the load, the stop is never in the past. A
    // load past its limit fails as a load
    {
        const loadLimit = 60_000
        const start = Date.UTC(2026, 0, 1)
        const { context, page } = await openPage(screen, "immersive")
        await page.clock.install({ time: start })
        await page.goto(`${site.url}/commands/`, { waitUntil: "load", timeout: loadLimit })
        await page.clock.pauseAt(start + 2 * loadLimit)
        const trigger = page.locator("[data-discover-trigger]")
        const open = () => trigger.getAttribute("aria-expanded")
        await trigger.hover()
        // Past the pause before hovering opens the menu
        await page.clock.runFor(60)
        if ((await open()) !== "true") report("hovering doesn't open the Discover menu", "/commands/")
        await trigger.click()
        if ((await open()) !== "true") report("a reflex click closes the Discover menu that hovering just opened", "/commands/")
        await page.clock.runFor(900)
        await trigger.click()
        if ((await open()) !== "false") report("a later click doesn't close the Discover menu", "/commands/")
        await context.close()
    }

    // Controls don't shrink under a finger on a touch screen
    {
        const { context, page } = await openPage({ width: 390, height: 844, touch: true }, "immersive")
        await page.goto(`${site.url}/docs/commands/`, { waitUntil: "load" })
        const shrinking = await page.evaluate(() => {
            const walk = (rules) => [...rules].flatMap((rule) => (rule.selectorText ? [rule] : !rule.cssRules || (rule.media && !matchMedia(rule.media.mediaText).matches) ? [] : walk(rule.cssRules)))
            return [...document.styleSheets].flatMap((sheet) => walk(sheet.cssRules)).filter((rule) => rule.selectorText?.includes(":active") && (rule.style.scale || /scale/.test(rule.style.transform))).map((rule) => rule.selectorText)
        })
        for (const selector of shrinking) report(`a control shrinks under a finger: ${selector}`, "touch")
        await context.close()
    }

    // Without WebGL the page end's black hole moves as plain layers, as it did before the hero's shader drew it
    const noWebgl = () => {
        const get = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
            return /webgl/.test(type) ? null : get.call(this, type, ...rest)
        }
    }

    // The light on the page end's black hole stays on the rim that is painted. With its head where the hole has no rim, it adds nothing
    const { context, page } = await openPage(screen, "immersive")
    await page.addInitScript(noWebgl)
    await page.goto(`${site.url}/`, { waitUntil: "load" })
    // Scrolled there as a reader does, a little at a time. One jump straight after loading can land before the page has its final height
    await page.waitForFunction(
        () => {
            window.scrollBy({ top: document.documentElement.scrollHeight, behavior: "instant" })
            window.scrollBy({ top: -40, behavior: "instant" })
            return document.querySelector(".alive[data-live]")
        },
        null,
        { timeout: 30000, polling: 500 },
    )
    // Once it has found it can't draw the hole, it says so
    const decided = await page.waitForSelector("[data-ending-alive][data-hole]", { state: "attached", timeout: 30000 }).then(() => true, () => false)
    const layers = await page.evaluate(() => ({ drawn: Boolean(document.querySelector("[data-ending-face]")), hole: document.querySelector("[data-ending-alive]").dataset.hole, turning: document.querySelector(".hole-ring").getAnimations().length }))
    const asLayers = decided && !layers.drawn && layers.hole === "layers" && layers.turning > 0
    if (!asLayers) report("without WebGL the page end's black hole doesn't move as plain layers", "/")
    const headBelow = asLayers && await page.evaluate(() => {
        for (const animation of document.getAnimations()) animation.pause()
        const [turning] = document.querySelector(".hole-ring").getAnimations()
        turning.currentTime = (turning.effect.getTiming().duration * 200) / 360
        return true
    })
    if (headBelow) {
        const box = await page.locator(".hole-rim").boundingBox()
        const picture = async () => sharp(await page.screenshot({ clip: box })).removeAlpha().raw().toBuffer()
        await frames(page)
        const lit = await picture()
        await page.addStyleTag({ content: ".hole-ring{visibility:hidden!important}" })
        await frames(page)
        const dark = await picture()
        let added = 0
        for (let i = 0; i < lit.length; i++) added += Math.abs(lit[i] - dark[i])
        if (added / lit.length > 0.4) report(`the black hole's light runs where no rim is painted: ${(added / lit.length).toFixed(1)} levels`, "/")
    }

    // The page end's conductor glides from one look to the next. Stepped through its own time a frame at a time, so a jump shows
    // whatever the machine's speed
    const eyesJump = await page.evaluate(() => {
        const looks = document.querySelector(".alive[data-live] .looks")
        const [look] = looks.getAnimations()
        let last = null
        let jump = 0
        for (let at = 0; at <= look.effect.getTiming().duration; at += 1000 / 60) {
            look.currentTime = at
            const moved = new DOMMatrix(getComputedStyle(looks).transform)
            if (last) jump = Math.max(jump, Math.hypot(moved.m41 - last.m41, moved.m42 - last.m42))
            last = moved
        }
        return jump
    })
    if (eyesJump > 1.5) report(`the page end's conductor's eyes jump ${eyesJump.toFixed(1)} px in one frame`, "/")
    await context.close()

    // The page end's black hole is drawn by the hero's own face shader and moves while the site moves. Only one face moves at a time:
    // with both on screen, the page end's holds while the hero's moves. Still lets it go. The page's CSS motion is paused for the
    // pictures, so only the shader can change them, and each wait is for a change to show, never a fixed time
    {
        const { context, page } = await openPage(screen, "immersive")
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        const heroFace = await page.waitForSelector("[data-face-slot] canvas[data-on]", { timeout: 60000 }).then(() => true, () => false)
        await page.waitForFunction(
            () => {
                window.scrollBy({ top: document.documentElement.scrollHeight, behavior: "instant" })
                window.scrollBy({ top: -40, behavior: "instant" })
                // Faded in over the plain layers, which have gone, so the fade can't pass for motion
                return document.querySelector("[data-ending-alive][data-hole='live'] [data-ending-face][data-on]")
            },
            null,
            { timeout: 60000, polling: 500 },
        ).catch(() => {})
        const shaders = await page.evaluate(() => {
            const sources = (canvas) => {
                const gl = canvas?.getContext("webgl2")
                const program = gl?.getParameter(gl.CURRENT_PROGRAM)
                return program ? gl.getAttachedShaders(program).filter((shader) => gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER).map((shader) => gl.getShaderSource(shader))[0] : null
            }
            return { ending: sources(document.querySelector("[data-ending-face][data-on]")), hero: sources(document.querySelector("[data-face-slot] canvas")) }
        })
        // Its own lines are the hero's, after HOLE_ONLY and the precision three.js puts before them
        const body = shaders.ending?.split("precision highp float;\n")[1]
        if (!heroFace) report("the hero's face never comes alive, so the page end's black hole can't be compared with it", "/")
        else if (!shaders.ending) report("the page end's black hole is not drawn by a shader", "/")
        else if (!shaders.ending.startsWith("#define HOLE_ONLY") || !body || !shaders.hero?.includes(body)) report("the page end's black hole is drawn by a shader other than the hero's face", "/")
        else {
            const shot = async (selector, from, to) => {
                const box = await page.locator(selector).boundingBox()
                const clip = { x: box.x + box.width * from[0], y: box.y + box.height * from[1], width: box.width * (to[0] - from[0]), height: box.height * (to[1] - from[1]) }
                return sharp(await page.screenshot({ clip })).removeAlpha().raw().toBuffer()
            }
            const change = (a, b) => {
                let sum = 0
                for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
                return a.length === b.length ? sum / a.length : Infinity
            }
            // The hole and the glass round it, which is opaque, so nothing behind the canvas shows
            const hole = () => shot(".hole-face", [0.2, 0.62], [0.8, 0.92])
            const heroHole = () => shot("[data-face-slot]", [0.2, 0.62], [0.8, 0.92])
            // Bounded by a time far past a slow machine's frames, only so a broken page can't hang the run
            const changes = async (picture, from) => {
                for (const until = Date.now() + 20000; Date.now() < until; ) if (change(from, await picture()) > 0.3) return true
                return false
            }
            // Keyframes only: the header's slide back in when the page goes up is a transition, and it must run
            await page.evaluate(() => {
                for (const animation of document.getAnimations()) if (animation instanceof CSSAnimation) animation.pause()
            })
            if (!(await changes(hole, await hole()))) report("the page end's black hole stands still while the site moves", "/")

            // Back at the top with the page end held on screen too
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }))
            await page.addStyleTag({ content: ".ending{position:fixed!important;left:0;right:0;bottom:0;z-index:50}" })
            const shown = await page.evaluate(() => {
                const box = document.querySelector(".hole-face").getBoundingClientRect()
                return box.top >= 0 && box.bottom <= innerHeight && document.querySelector("[data-face-slot]").getBoundingClientRect().bottom > 0
            })
            if (!shown) report("the check can't put both faces on screen at once", "/")
            else {
                // Once the hero's face has moved, its turn has come. From then the page end's must stay as it is while the hero's moves on
                const heroMoves = await changes(heroHole, await heroHole())
                const held = await hole()
                const heroMovesOn = await changes(heroHole, await heroHole())
                const drift = change(held, await hole())
                if (!heroMoves || !heroMovesOn) report("the hero's face stands still on screen", "/")
                else if (drift > 0.05) report(`two faces move at once: the page end's black hole changes by ${drift.toFixed(2)} levels while the hero's moves`, "/")
            }

            await page.waitForSelector(".site-header:not([data-hidden]) .motion[data-ready]", { timeout: 15000 })
            await page.click(".motion[data-ready]")
            const gone = await page.waitForFunction(() => !document.querySelector("[data-ending-face]"), null, { timeout: 15000 }).then(() => true, () => false)
            if (!gone) report("the page end's black hole keeps drawing after a press to Still", "/")
        }
        await context.close()
    }

    // In Still it never starts: the page end's living parts are not asked for, so nothing draws the black hole
    {
        const { context, page } = await openPage(screen, "still")
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        await page.waitForFunction(
            () => {
                window.scrollBy({ top: document.documentElement.scrollHeight, behavior: "instant" })
                return document.querySelector(".ending[data-on]")
            },
            null,
            { timeout: 30000, polling: 500 },
        )
        const started = await page.evaluate(() => Boolean(document.querySelector("[data-ending-face]") || document.querySelector("[data-ending-alive]").dataset.loading !== undefined))
        if (started) report("the page end's black hole comes alive in Still", "/")
        await context.close()
    }

    // The hero's cap fills with the breath while the site moves, and is gone once it goes still. How smoothly it moves is
    // tests/face-life.test.ts's to check, since frames in a browser come when they will
    {
        const { context, page } = await openPage(screen, "immersive")
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        const capHere = await page.waitForSelector("[data-conductor] [data-cap]", { state: "attached", timeout: 60000 }).then(() => true, () => false)
        if (!capHere) report("the hero's cap never comes alive", "/")
        else {
            const first = await page.evaluate(() => document.querySelector("[data-cap]").style.transform)
            const moves = await page.waitForFunction((was) => document.querySelector("[data-cap]").style.transform !== was, first, { timeout: 15000 }).then(() => true, () => false)
            if (!moves) report("the hero's cap stands still while the site moves", "/")
            await page.click(".motion[data-ready]")
            const gone = await page.waitForFunction(() => !document.querySelector("[data-cap]"), null, { timeout: 15000 }).then(() => true, () => false)
            if (!gone) report("the hero's cap stays alive after a press to still", "/")
        }
        await context.close()
    }

    // The hero's bow tie wiggles from its knot while the site moves, and once it goes still the bow is gone and the painted
    // conductor whole again. How it moves is tests/face-life.test.ts's to check. A page opened in Still never asks for it
    {
        const { context, page } = await openPage(screen, "immersive")
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        const bowHere = await page.waitForSelector("[data-conductor] [data-bow]", { state: "attached", timeout: 60000 }).then(() => true, () => false)
        if (!bowHere) report("the hero's bow tie never comes alive", "/")
        else {
            // Turned once, then turned to another angle, so a bow stuck at a tilt doesn't pass. Bounded by a few of its wiggles,
            // which come about every five seconds, only so a broken page can't hang the run
            const angle = () => Number(/rotate\(([-\d.e]+)rad\)/.exec(document.querySelector("[data-bow]").style.transform)?.[1] ?? 0)
            const tilt = await page.waitForFunction(`Math.abs((${angle})()) > 0.005 && (${angle})()`, null, { timeout: 30000 }).then((handle) => handle.jsonValue(), () => null)
            const wiggles = tilt !== null && (await page.waitForFunction(`Math.abs((${angle})() - ${tilt}) > 0.005`, null, { timeout: 30000 }).then(() => true, () => false))
            if (!wiggles) report("the hero's bow tie stands still while the site moves", "/")
            await page.click(".motion[data-ready]")
            const gone = await page.waitForFunction(() => !document.querySelector("[data-bow]") && !document.querySelector("[data-mascot]").style.maskImage, null, { timeout: 15000 }).then(() => true, () => false)
            if (!gone) report("the hero's bow tie stays alive after a press to still, or leaves the painted bow cut out", "/")
        }
        await context.close()
    }
    {
        const { context, page } = await openPage(screen, "still")
        const asked = []
        page.on("request", (request) => /\/art\/bow-/.test(request.url()) && asked.push(request.url()))
        await page.goto(`${site.url}/`, { waitUntil: "networkidle" })
        await frames(page)
        const live = await page.evaluate(() => Boolean(document.querySelector("[data-bow]") || document.querySelector("[data-mascot]").style.maskImage))
        if (live || asked.length) report("the hero's bow tie comes alive in Still", "/")
        await context.close()
    }

    // A press to Still releases the hero's scene with every listener it added, so switching back and forth keeps one scene's
    // listeners instead of gaining a set per switch. Each count waits for the old scene's canvas to go, which happens as it is released
    {
        const { context, page } = await openPage(screen, "immersive")
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        const cdp = await context.newCDPSession(page)
        const listenersOn = async (expression) => {
            const { result } = await cdp.send("Runtime.evaluate", { expression })
            const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId })
            await cdp.send("Runtime.releaseObject", { objectId: result.objectId })
            return listeners.map((listener) => listener.type)
        }
        const count = async () => {
            const types = [...(await listenersOn("window")), ...(await listenersOn('document.querySelector("[data-hero] .control.primary")'))]
            return types.filter((type) => ["fluxerly:copied", "pointerenter", "pointerleave", "focus", "blur"].includes(type)).length
        }
        const live = () => page.waitForSelector("[data-hero][data-scene=live]", { state: "attached", timeout: 60000 }).then(() => true, () => false)
        if (!(await live())) report("the hero's scene never comes alive", "/")
        else {
            const first = await count()
            let switched = true
            for (let round = 0; round < 3 && switched; round += 1) {
                await page.click(".motion[data-ready]")
                switched = await page.waitForFunction(() => !document.querySelector("[data-scene-slot] canvas:not([data-scene-frame])"), null, { timeout: 15000 }).then(() => true, () => false)
                if (!switched) report("the hero's scene stays after a press to Still", "/")
                else {
                    await page.click(".motion[data-ready]")
                    switched = await live()
                    if (!switched) report("the hero's scene doesn't come back after a press to Motion", "/")
                }
            }
            const last = await count()
            if (switched && last !== first) report(`the hero keeps old scenes' listeners: ${first} before switching to Still and back three times, ${last} after`, "/")
        }
        await context.close()
    }

    // A message reaching the conductor charges its mouth and spreads a ring on the water under it, and both must be plain to see.
    // The page's clock stands still from before the page loads and moves only a tenth of a second at a time, so every run draws
    // the same frames for the same scene times, however busy the machine is, and the canvases keep what they drew so they can be
    // read. Each is measured against the moment just before the message, on one screen, in luminance levels out of 255: The
    // mouth's strokes on average, and the brightest rise of the water's rows under the conductor. They were 27 and about 32
    // levels when both were too faint to notice. With no ring at all, the water's own shimmer moves its rows by about 30 levels
    // over this message, and a ring at half its strength reads about 38
    {
        const { context, page } = await openPage({ width: 1280, height: 800 }, "immersive")
        await page.addInitScript(() => {
            const get = HTMLCanvasElement.prototype.getContext
            HTMLCanvasElement.prototype.getContext = function (type, options) {
                return get.call(this, type, /webgl/.test(type) ? { ...options, preserveDrawingBuffer: true } : options)
            }
        })
        // A clock left running while the page loads moves on with the machine's speed, and so did which message was measured
        // and where in its charge the measuring began, which could leave the ring in the moment taken as before it
        const opened = Date.now()
        await page.clock.install({ time: opened })
        await page.clock.pauseAt(opened + 1000)
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        // The scene and its face load only as the clock moves. Frames are counted from the scene's first one, the scene time
        // its rhythm follows. The wait is bounded only so a broken page can't hang the run
        let steps = 0
        let live = -1
        let faceHere = false
        for (const given = Date.now() + 120000; !faceHere && Date.now() < given; ) {
            await page.clock.fastForward(100)
            steps++
            const state = await page.evaluate(() => ({ live: document.querySelector("[data-hero]")?.dataset.scene === "live", face: Boolean(document.querySelector("[data-face-slot] canvas")) }))
            if (state.live && live < 0) live = steps
            faceHere = state.face
        }
        if (!faceHere) report("the hero's face never comes alive, so its charge and the ring on the water can't be measured", "/")
        else {
            // On to the scene's eighth second, or 3 s after the face came if it came late, so the face has woken. From the same
            // frame in every run, however long the face took to load, so the same message is measured from the same place
            const drawn = steps - live
            for (let frame = drawn; frame < Math.max(80, drawn + 30); frame++) await page.clock.fastForward(100)
            // Where the conductor stands, taken once: it bobs, and the water must be read in the same place every frame
            const stands = await page.evaluate(() => {
                const box = document.querySelector("[data-conductor]").getBoundingClientRect()
                return { left: box.left, bottom: box.bottom, width: box.width, height: box.height }
            })
            const read = () =>
                page.evaluate((box) => {
                    const pixels = (canvas, left, top, width, height) => {
                        const copy = document.createElement("canvas")
                        copy.width = width
                        copy.height = height
                        const context = copy.getContext("2d")
                        context.drawImage(canvas, left, top, width, height, 0, 0, width, height)
                        return context.getImageData(0, 0, width, height).data
                    }
                    const light = (data, index) => 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]
                    // The mouth's strokes, in the face's own canvas: the 2048 canvas's box from 870,1140 to 1160,1260 in the glass's
                    const face = document.querySelector("[data-face-slot] canvas")
                    const left = Math.round(((870 - 537) / 992) * face.width)
                    const top = Math.round(((1140 - 800) / 815) * face.height)
                    const mouth = pixels(face, left, top, Math.round((290 / 992) * face.width), Math.round((120 / 815) * face.height))
                    let sum = 0
                    for (let index = 0; index < mouth.length; index += 4) sum += light(mouth, index)
                    // The water's rows under the conductor, two of its widths wide and from its feet down 60% of its height
                    const world = document.querySelector("[data-scene-slot] canvas")
                    const scale = world.width / world.clientWidth
                    const width = Math.round(box.width * 2 * scale)
                    const height = Math.round(box.height * 0.6 * scale)
                    const water = pixels(world, Math.round((box.left - box.width * 0.5) * scale), Math.round(box.bottom * scale), width, height)
                    const rows = []
                    for (let row = 0; row < height; row++) {
                        let line = 0
                        for (let column = 0; column < width; column++) line += light(water, (row * width + column) * 4)
                        rows.push(line / width)
                    }
                    return { mouth: sum / (mouth.length / 4), rows: rows.map((value, row) => (value + (rows[row - 1] ?? value) + (rows[row + 1] ?? value)) / 3) }
                }, stands)
            // Frames a tenth of a second apart. A message counts when its charge starts after a second of quiet in the mouth, never
            // when one is already under way as the reading starts. Bounded by two of the rhythm's 22 s breaths, only so a broken
            // page can't hang the run
            const seen = []
            let onset = -1
            for (let frame = 0; frame < 440 && (onset < 0 || frame < onset + 30); frame++) {
                await page.clock.fastForward(100)
                seen.push(await read())
                const now = seen.length - 1
                const quiet = (from, to) => Math.max(...seen.slice(from, to).map((frame) => frame.mouth)) - Math.min(...seen.slice(from, to).map((frame) => frame.mouth)) < 2
                const fills = (at) => seen[at].mouth - seen[at - 10].mouth > 3
                if (onset < 0 && now >= 20 && fills(now) && !fills(now - 1) && quiet(now - 20, now - 9)) onset = now
            }
            if (onset < 0) report("no message charges the conductor's mouth in two breaths of the rhythm", "/")
            else {
                // The message arrives a moment before the mouth starts to fill, and the ring starts with it, so the moment before
                // both is a second earlier, in the quiet
                const before = seen[onset - 12]
                const after = seen.slice(onset - 11)
                const charge = Math.max(...after.map((frame) => frame.mouth)) - before.mouth
                const ring = Math.max(...after.map((frame) => Math.max(...frame.rows.map((value, row) => value - before.rows[row]))))
                if (charge < 36) report(`the conductor's mouth charges by only ${charge.toFixed(1)} levels, too faint to notice`, "/")
                if (ring < 44) report(`the ring a message leaves on the water rises by only ${ring.toFixed(1)} levels, too faint to notice`, "/")
            }
        }
        await context.close()
    }
})

part("questions", ["/"], async () => {
    await inParallel(sizes.filter((size) => size.quick || size.width === 390), async (size) => {
        const { context, page } = await openPage(size, "immersive")
        await page.addInitScript(watchLine)
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        await settle(page)
        const result = await page.evaluate(async () => {
            const items = [...document.querySelectorAll("#questions details.item")]
            const frame = () => new Promise((done) => requestAnimationFrame(done))
            const settled = async (element) => {
                let still = 0
                for (let last = NaN, frames = 0; still < 8 && frames < 600; frames++) {
                    await frame()
                    const top = element.getBoundingClientRect().top
                    still = top === last ? still + 1 : 0
                    last = top
                }
            }
            // Frame by frame until it holds, with a bound only so a broken page can't hang the run
            const until = async (holds) => {
                for (let frames = 0; !holds() && frames < 6000; frames++) await frame()
            }
            // After a press or a scroll: the answers' glides over and the sizes they leave seen, the page done following the
            // press, the signal line drawn again for the page's new height, and then the question still
            const rested = async (element) => {
                await frame()
                await frame()
                const timed = document.documentElement.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running" && animation.timeline instanceof DocumentTimeline && animation.effect?.getTiming().iterations !== Infinity)
                await Promise.allSettled(timed.map((animation) => animation.finished))
                await frame()
                await frame()
                // Questions.astro clears this once it stops following a press
                await until(() => !document.documentElement.style.overflowAnchor)
                await until(() => !window.lineDue)
                await settled(element)
            }
            const summaryOf = (index) => items[index].querySelector("summary")
            const answer = getComputedStyle(items[1], "::details-content")
            const glides = getComputedStyle(items[1]).interpolateSize === "allow-keywords" && answer.transitionProperty.split(", ").includes("height") && parseFloat(answer.transitionDuration) > 0

            // Nothing open above: the pressed question stays where it is
            summaryOf(0).scrollIntoView({ block: "center", behavior: "instant" })
            await settled(summaryOf(0))
            const firstTop = summaryOf(0).getBoundingClientRect().top
            summaryOf(0).click()
            await rested(summaryOf(0))
            const firstMoved = Math.abs(summaryOf(0).getBoundingClientRect().top - firstTop)

            // Tapping the next question again and again, as long as it's on screen: the page stays put and each answer opens on screen
            let pageMoved = 0
            let sank = 0
            for (let index = 1; index < items.length; index++) {
                const summary = summaryOf(index)
                const before = summary.getBoundingClientRect().top
                if (before + summary.offsetHeight > innerHeight) {
                    summary.scrollIntoView({ block: "center", behavior: "instant" })
                    await settled(summary)
                }
                const y = scrollY
                const top = summary.getBoundingClientRect().top
                summary.click()
                await rested(summary)
                const after = summary.getBoundingClientRect().top
                // At the header the page has to follow, so only a question clear of it counts
                if (after > 100) pageMoved = Math.max(pageMoved, Math.abs(scrollY - y))
                sank = Math.max(sank, after - top)
            }

            // A long answer above and the next question near the top: it stays clear of the header instead of leaving the screen
            summaryOf(0).click()
            await rested(summaryOf(0))
            summaryOf(1).scrollIntoView({ block: "start", behavior: "instant" })
            window.scrollBy({ top: -100, behavior: "instant" })
            await settled(summaryOf(1))
            summaryOf(1).click()
            await rested(summaryOf(1))
            const hidden = summaryOf(1).getBoundingClientRect().top < 80

            // Scrolling right after a press still scrolls
            const other = summaryOf(2)
            other.scrollIntoView({ block: "center", behavior: "instant" })
            await settled(other)
            other.click()
            await frame()
            await frame()
            const before = other.getBoundingClientRect().top
            window.scrollBy({ top: 120, behavior: "instant" })
            await rested(other)
            const scrolled = before - other.getBoundingClientRect().top

            // Deep in the list with the heading pinned: opening an answer leaves the signal line above it alone
            const lineAbove = () => {
                const index = [...document.querySelectorAll("[data-station]")].indexOf(document.querySelector('[data-station="questions"]'))
                const station = document.querySelectorAll(".thread-stations .station")[index]
                return { station, place: station?.getAttribute("transform"), bead: document.querySelector("[data-beads] .bead"), line: document.querySelector("[data-thread-line]").getAttribute("d").split(" L ")[0] }
            }
            const deep = summaryOf(items.length - 1)
            deep.scrollIntoView({ block: "center", behavior: "instant" })
            await rested(deep)
            const lineBefore = lineAbove()
            deep.click()
            await rested(deep)
            const lineAfter = lineAbove()
            const lineMoved = lineBefore.place !== lineAfter.place || lineBefore.line !== lineAfter.line
            const lineRemade = lineBefore.station !== lineAfter.station || lineBefore.bead !== lineAfter.bead
            return { glides, firstMoved, pageMoved, sank, hidden, open: items.filter((item) => item.open).length, scrolled, lineMoved, lineRemade }
        })
        if (!result.glides) report("a question's answer jumps open instead of gliding", `${size.width}x${size.height}`)
        if (result.open !== 1) report(`${result.open} questions open at once`, `${size.width}x${size.height}`)
        if (result.firstMoved > 6) report(`a pressed question with nothing open above it moved ${Math.round(result.firstMoved)} px`, `${size.width}x${size.height}`)
        if (result.pageMoved > 6) report(`tapping a question below an open one scrolled the page ${Math.round(result.pageMoved)} px`, `${size.width}x${size.height}`)
        if (result.sank > 6) report(`a pressed question sank ${Math.round(result.sank)} px down the screen`, `${size.width}x${size.height}`)
        if (result.hidden) report("a pressed question slid under the header", `${size.width}x${size.height}`)
        if (result.lineMoved) report("opening an answer deep in the list moved the signal line above it", `${size.width}x${size.height}`)
        if (result.lineRemade) report("opening an answer remade the line's markers and beads above it", `${size.width}x${size.height}`)
        if (result.scrolled < 60) report(`scrolling after pressing a question moved only ${Math.round(result.scrolled)} px`, `${size.width}x${size.height}`)
        await context.close()
    })
})

serial("choice", ["/", "/commands/", "/docs/commands/"], async (pages) => {
    // A press of the switch wins over the system asking for less motion: still with nothing saved, moving after a press and after a reload,
    // on each kind of page, with no moment of the other mode, and still again after a second press
    const { width, height } = sizes.find((candidate) => !candidate.touch && candidate.width >= 1280) ?? sizes[0]
    const open = async (extra) => {
        const context = await newContext({ viewport: { width, height }, reducedMotion: "reduce" })
        const page = await context.newPage()
        page.on("pageerror", (error) => report(`page error: ${error.message.slice(0, 120)}`, "choice"))
        // Every mode this page load has shown, from the first moment the body exists
        await page.addInitScript(() => {
            const seen = (window.seenStill = [])
            let started = false
            new MutationObserver(() => {
                if (!document.body) return
                if (!started) seen.push(document.documentElement.hasAttribute("data-still"))
                started = true
                for (const element of document.querySelectorAll("[data-still]:not(.peek-card)")) if (!seen.includes(element.tagName)) seen.push(element.tagName)
            }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-still"] })
        })
        if (extra) await page.addInitScript(extra)
        return { context, page }
    }
    // Whether each moving thing on the page is running, once the header's switch knows the state
    const reading = async (page) => {
        await page.waitForSelector(".motion[data-ready]", { timeout: 30000 })
        return page.evaluate(() => {
            const running = (element, subtree = false) => element.getAnimations({ subtree }).filter((animation) => animation.playState === "running").length > 0
            const world = document.querySelector(".night, .docs-night")
            return {
                still: document.documentElement.hasAttribute("data-still"),
                held: document.querySelectorAll("[data-still]:not(html):not(.peek-card)").length > 0,
                checked: document.querySelector(".motion").getAttribute("aria-checked") === "true",
                logo: running(document.querySelector(".home-waves")),
                wave: running(document.querySelector(".motion-wave")),
                world: running(world, true),
                seen: window.seenStill,
            }
        })
    }
    const expectMode = (state, moving, where) => {
        if (state.still === moving) report(`<html> has the wrong mode for ${moving ? "a saved press to run" : "still"}`, where)
        if (state.held === moving) report(`a page part has the wrong mode for ${moving ? "a saved press to run" : "still"}`, where)
        if (state.checked !== moving) report(`the switch reads ${state.checked ? "on" : "off"}`, where)
        if (state.logo !== moving) report(`the logo's waves ${moving ? "stand still" : "move"}`, where)
        if (state.wave !== moving) report(`the switch's waves ${moving ? "stand still" : "move"}`, where)
        if (state.world !== moving) report(`the page's world ${moving ? "stands still" : "moves"}`, where)
    }
    // On the homepage, whether the sky has reached the state asked for. The live scene takes over from the frozen frame in its own time
    const skyIs = (page, mode) => page.waitForFunction((want) => (document.querySelector("[data-hero]").dataset.scene === "live") === (want === "immersive"), mode, { timeout: 60000 }).then(() => true, () => false)

    const { context, page } = await open()
    for (const route of pages) {
        await page.goto(site.url + route, { waitUntil: "load" })
        expectMode(await reading(page), false, `nothing saved ${route}`)
    }
    await page.goto(`${site.url}/`, { waitUntil: "load" })
    await reading(page)
    await page.click(".motion")
    expectMode(await reading(page), true, "after a press /")
    if (!(await skyIs(page, "immersive"))) report("the hero's sky stays frozen after a press", "/")
    if ((await page.evaluate((key) => localStorage.getItem(key), experienceKey)) !== "immersive") report("a press isn't saved", "/")
    for (const route of pages) {
        await page.goto(site.url + route, { waitUntil: "load" })
        const state = await reading(page)
        expectMode(state, true, `after a reload ${route}`)
        if (state.seen.some(Boolean)) report(`a saved press to run shows still for a moment: ${state.seen.filter(Boolean).join(",")}`, route)
    }
    await page.goto(`${site.url}/`, { waitUntil: "load" })
    if (!(await skyIs(page, "immersive"))) report("the hero's sky stays frozen after a reload with a saved press", "/")
    await page.click(".motion[data-ready]")
    expectMode(await reading(page), false, "after a second press /")
    if (!(await skyIs(page, "still"))) report("the hero's sky keeps moving after a second press", "/")
    for (const route of pages) {
        await page.goto(site.url + route, { waitUntil: "load" })
        const state = await reading(page)
        expectMode(state, false, `after a second press and a reload ${route}`)
        if (state.seen[0] !== true) report("a saved still shows motion for a moment", route)
    }
    await context.close()

    // With storage blocked a press lasts for the page, and the system decides again on the next
    const blocked = await open(() => Object.defineProperty(window, "localStorage", { get: () => { throw new DOMException("blocked", "SecurityError") } }))
    await blocked.page.goto(`${site.url}/`, { waitUntil: "load" })
    expectMode(await reading(blocked.page), false, "storage blocked")
    await blocked.page.click(".motion")
    expectMode(await reading(blocked.page), true, "storage blocked, after a press")
    await blocked.page.reload({ waitUntil: "load" })
    expectMode(await reading(blocked.page), false, "storage blocked, after a reload")
    await blocked.context.close()

    // Nothing is left turning once a page goes still, whichever way it got there. Moving icons are the ones to watch, so each case waits for them
    const forever = (page) => page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect.getTiming().iterations === Infinity).map((animation) => `${animation.animationName} on ${animation.effect.target.getAttribute("class")?.split(" ")[0]}`))
    const iconMoving = (page) => page.waitForSelector(".motion[data-ready]", { timeout: 30000 }).then(() => page.waitForFunction(() => document.querySelector(".companion[data-live] .part[data-move]")?.getAnimations().length > 0, null, { timeout: 30000 })).then(() => true, () => false)
    const expectStopped = async (page, how) => {
        await page.waitForFunction(() => document.documentElement.hasAttribute("data-still"), null, { timeout: 15000 }).catch(() => report(`<html> isn't still ${how}`, "/commands/"))
        // A frame for the styles to apply, and asked of the animations themselves
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
        for (const left of await forever(page)) report(`${left} keeps running ${how}`, "/commands/")
    }
    {
        const pressed = await open()
        await pressed.page.goto(`${site.url}/commands/`, { waitUntil: "load" })
        await pressed.page.waitForSelector(".motion[data-ready]", { timeout: 30000 })
        await pressed.page.click(".motion")
        if (!(await iconMoving(pressed.page))) report("a moving icon never moved after a press", "/commands/")
        await pressed.page.click(".motion")
        await expectStopped(pressed.page, "after a press to run and a press to still")
        await pressed.context.close()
    }
    {
        const context = await newContext({ viewport: { width, height } })
        const page = await context.newPage()
        await page.goto(`${site.url}/commands/`, { waitUntil: "load" })
        if (!(await iconMoving(page))) report("a moving icon never moved", "/commands/")
        await page.emulateMedia({ reducedMotion: "reduce" })
        await expectStopped(page, "after the system asks for less motion")
        await context.close()
    }
    {
        // The system's setting changes while the page's scripts are still on their way
        const context = await newContext({ viewport: { width, height } })
        const page = await context.newPage()
        let letThrough = () => {}
        const held = new Promise((done) => (letThrough = done))
        await context.route(/\/_astro\/.*\.js$/, async (route) => {
            await held
            await route.continue()
        })
        // Waiting modules hold up DOMContentLoaded, so this waits for the page's markup instead
        await page.goto(`${site.url}/commands/`, { waitUntil: "commit" })
        await page.waitForSelector(".motion", { state: "attached", timeout: 30000 })
        await page.emulateMedia({ reducedMotion: "reduce" })
        letThrough()
        await page.waitForSelector(".motion[data-ready]", { timeout: 30000 })
        await expectStopped(page, "after the system asks for less motion while the scripts load")
        await context.close()
    }
})

serial("sky", ["/", "/docs/"], async () => {
    // With time stopped the sky's icons and the frozen frame appear without a fade
    {
        const context = await newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" })
        const page = await context.newPage()
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        // The frozen frame arrives after the page has loaded, and a missing one would pass unchecked
        await page.waitForSelector("canvas[data-scene-frame]", { state: "attached", timeout: 30000 })
        // Once the frame shows, another rule hides the icons with no fade, so they're read without it
        const fades = await page.evaluate(() => {
            document.querySelector(".hero").removeAttribute("data-scene")
            return [".sky-icons", "canvas[data-scene-frame]"].filter((selector) => getComputedStyle(document.querySelector(selector)).transitionDuration !== "0s")
        })
        for (const selector of fades) report(`${selector} still fades with time stopped`, "sky")
        await context.close()
    }
    // A screen this size picks the small file of each, which nothing else on the page asks for
    const screen = { width: 1366, height: 768 }

    // A first visit asks for the sky's icons only once the conductor is whole. With its picture held back the hero's script has run and placed
    // them, and none is asked for. Each then comes once it is let through. The page holds them back until the conductor is whole, or for a
    // few seconds at most on a slow network, so each request is timed against the moment the page lets them go, both by the page's own clock
    {
        const { context, page } = await openPage(screen, "immersive")
        await page.addInitScript(() => {
            performance.setResourceTimingBufferSize(10000)
            new MutationObserver((changes, watch) => {
                if (document.documentElement.hasAttribute("data-icons-held")) return
                window.iconsLetGo = performance.now()
                watch.disconnect()
            }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-icons-held"] })
        })
        let letThrough = () => {}
        const held = new Promise((done) => (letThrough = done))
        await context.route(/\/art\/mascot-/, async (route) => {
            await held
            await route.continue()
        })
        await page.goto(`${site.url}/`, { waitUntil: "domcontentloaded" })
        await page.waitForFunction(() => [...document.querySelectorAll("[data-sky-icon]")].some((icon) => !icon.hidden), null, { timeout: 30000 })
        letThrough()
        const shown = await page.waitForFunction(() => [...document.querySelectorAll("[data-sky-icon]")].filter((icon) => !icon.hidden).every((icon) => icon.complete && icon.naturalWidth > 0), null, { timeout: 30000 }).then(() => true, () => false)
        const early = await page.evaluate(() => {
            const small = [...document.querySelectorAll("[data-sky-icon]")].map((icon) => icon.getAttribute("src"))
            return performance.getEntriesByType("resource").filter((entry) => small.includes(new URL(entry.name).pathname) && !(entry.startTime >= window.iconsLetGo)).length
        })
        if (early) report(`${early} of the sky's icons are asked for before the conductor is whole`, "/")
        if (!shown) report("the sky's icons never come after the conductor is whole", "/")
        await context.close()
    }

    // A return shows them at once: no fade, and the head knows it before the first paint
    {
        const { context, page } = await openPage(screen, "immersive")
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        const known = await page.waitForFunction((key) => localStorage.getItem(key) !== null, skyIconsKey, { timeout: 30000 }).then(() => true, () => false)
        if (!known) report("a visit never records that the sky's icons have arrived", "/")
        await page.goto(`${site.url}/docs/`, { waitUntil: "load" })
        await page.addInitScript(() => new MutationObserver((changes, watch) => {
            if (!document.querySelector("[data-hero]")) return
            window.artKnownBeforeHero = document.documentElement.hasAttribute("data-art-here")
            watch.disconnect()
        }).observe(document, { subtree: true, childList: true }))
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        const back = await page.evaluate(() => ({ known: window.artKnownBeforeHero, fade: parseFloat(getComputedStyle(document.querySelector(".sky-icons")).transitionDuration), mascotFade: parseFloat(getComputedStyle(document.querySelector("[data-mascot]")).transitionDuration), held: document.documentElement.hasAttribute("data-icons-held") }))
        if (!back.known) report("a return to the homepage doesn't know the sky's icons are cached before the first paint", "/")
        if (back.held) report("a return to the homepage holds the sky's icons back", "/")
        if (back.fade > 0) report("the sky's icons fade in on a return to the homepage", "/")
        if (back.mascotFade > 0) report("the conductor fades in on a return to the homepage", "/")
        await context.close()
    }
})

part("noscript", routes, async () => {
    // Without script nothing can read a saved choice, so the system asking for less motion stops everything, and that includes what a * rule can't reach
    await inParallel(routes.filter(covers), async (route) => {
        const context = await newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce", javaScriptEnabled: false })
        const page = await context.newPage()
        await page.goto(site.url + route, { waitUntil: "load" })
        const moving = await page.evaluate(() => ({
            running: document.getAnimations().filter((animation) => animation.playState === "running").map((animation) => animation.animationName ?? animation.transitionProperty),
            drawn: [...document.querySelectorAll("animate,animateMotion,animateTransform")].filter((animation) => getComputedStyle(animation.parentElement).display !== "none").length,
            gliding: [...document.querySelectorAll("details")].filter((details) => getComputedStyle(details, "::details-content").transitionDuration.split(", ").some((time) => parseFloat(time) > 0)).length,
        }))
        for (const name of new Set(moving.running)) report(`without script ${name} runs under reduced motion`, route)
        if (moving.drawn) report(`without script ${moving.drawn} SVG animations stay on screen under reduced motion`, route)
        if (moving.gliding) report(`without script ${moving.gliding} folding sections glide open under reduced motion`, route)
        await context.close()
    })
})

serial("docs", ["/docs/"], async () => {
    const wide = { width: 1366, height: 768 }
    // Pagefind itself leaves one promise unhandled when its index can't load, which a browser only logs. Every other page
    // error still counts
    const openPage = async (size) => {
        const context = await newContext({ viewport: size })
        const page = await context.newPage()
        page.on("pageerror", (error) => {
            if (!/^Failed to load Pagefind metadata/.test(error.message)) report(`page error: ${error.message.slice(0, 120)}`, `${size.width}x${size.height}`)
        })
        await page.addInitScript(([key, value, tour]) => {
            localStorage.setItem(key, value)
            localStorage.setItem(tour, "1")
        }, [experienceKey, "still", tourKey])
        return { context, page }
    }

    // Every docs page names the Fluxer commit its docs were checked against, in the sidebar on a wide screen and in the docs
    // menu on a phone, and the overview names it again in the page. That is the repository's pin, except on the public site,
    // whose docs at /docs/ come from the newest published version's snapshot and so name that version's own pin
    {
        const manifest = JSON.parse(await readFile(new URL("../../../release/upstream/manifest.json", import.meta.url), "utf8"))
        const pinned = (await publicPin()) ?? manifest.commit
        const pinUrl = `https://github.com/${manifest.repository}/commit/${pinned}`
        for (const [size, path] of [[wide, "/docs/"], [wide, "/docs/api/"], [{ width: 390, height: 844 }, "/docs/commands/"]]) {
            const { context, page } = await openPage(size)
            await page.goto(`${site.url}${path}`, { waitUntil: "load" })
            const menuButton = page.locator(".side-open")
            if (await menuButton.isVisible()) {
                await menuButton.click()
                await page.locator(".docs-side[data-open]").waitFor({ timeout: 5000 }).catch(() => {})
            }
            const link = page.locator(".fluxer-pin a")
            const shown = (await link.count()) === 1 && (await link.isVisible()) && (await link.getAttribute("href")) === pinUrl && (await link.textContent()).trim() === pinned.slice(0, 7)
            if (!shown) report("the docs sidebar doesn't show the pinned Fluxer commit", `${path} ${size.width}x${size.height}`)
            if (path === "/docs/" && (await page.locator(`.fluxer-pin-note a[href="${pinUrl}"]`).count()) !== 1) report("the docs overview doesn't name the pinned Fluxer commit", path)
            await context.close()
        }
    }

    // A request URL pasted into the endpoint map finds its route, with Fluxer's /api prefix or without it
    {
        const { context, page } = await openPage(wide)
        await page.goto(`${site.url}/docs/api/endpoints/`, { waitUntil: "load" })
        for (const pasted of ["https://fluxer.com/api/v1/channels/123/messages", "https://api.example.com/v1/channels/123/messages"]) {
            await page.fill("[data-ep-query]", pasted)
            const found = await page
                .waitForFunction(() => [...document.querySelectorAll("[data-ep-row]:not([hidden])")].some((row) => row.dataset.epPath === "/channels/{channel_id}/messages"), undefined, { timeout: 15000 })
                .then(() => true, () => false)
            if (!found) report(`a pasted request URL finds no route in the endpoint map: ${pasted}`, "/docs/api/endpoints/")
        }
        await context.close()
    }

    // Opens search on a docs page and types a query. The dialog reports through its status line and its list of results
    const openSearch = async (page) => {
        await page.goto(`${site.url}/docs/`, { waitUntil: "load" })
        await page.waitForFunction(() => document.querySelector(".search-open") && Object.keys(document.querySelector(".search-open")).some((key) => key.startsWith("__react")), null, { timeout: 30000 })
        // A phone keeps the button in its closed menu, and the shortcut opens the same dialog
        const button = page.locator(".search-open:visible")
        if (await button.count()) await button.first().click()
        else await page.keyboard.press("Control+k")
    }
    const hits = (page) => page.locator(".search-results a")
    const hitUnder = (page, path) => page.waitForSelector(`.search-results a[href*="${path}"]`, { timeout: 30000 }).then(() => true, () => false)
    const retryShown = (page) => page.waitForSelector(".search-retry", { timeout: 30000 }).then(() => true, () => false)
    const saysNothing = (page) => page.locator(".search-status", { hasText: "Nothing found" }).count()

    // A question finds the guide written for it, and an API name still finds its entry
    for (const [query, path] of [["how do I send a message", "/docs/messages/"], ["runBot", "/docs/api/"], ["guild.create", "/docs/api/"]]) {
        const { context, page } = await openPage(wide)
        await openSearch(page)
        await page.fill(".search-dialog input", query)
        if (!(await hitUnder(page, path))) report(`search for "${query}" finds nothing under ${path}`, "/docs/")
        await context.close()
    }

    // A method's full name, as the reference lists it or as code calls it, finds its entry, whose heading shows only its own name
    for (const [query, path] of [
        ["messages.send", "/docs/api/js-ts/messages/#messages-send"],
        ["client.messages.send", "/docs/api/js-ts/messages/#messages-send"],
        ["members.fetch", "/docs/api/js-ts/guilds-and-members/#members-fetch"],
        ["threads.join", "/docs/api/js-ts/channels/#threads-join"],
    ]) {
        const { context, page } = await openPage(wide)
        await openSearch(page)
        await page.fill(".search-dialog input", query)
        if (!(await hitUnder(page, path))) report(`search for "${query}" doesn't find its reference entry ${path}`, "/docs/")
        await context.close()
    }

    // Searching runs in a web worker, so typing never waits for it. On the page it held up each key for seconds on a
    // slow phone. The page's own requests for the index's word chunks show where it ran
    {
        const { context, page } = await openPage(wide)
        await openSearch(page)
        for (const query of ["runBot", "message create"]) {
            await page.fill(".search-dialog input", query)
            if (!(await hitUnder(page, "/docs/"))) report(`search for "${query}" finds nothing`, "/docs/")
        }
        const onPage = await page.evaluate(() => performance.getEntriesByType("resource").filter((entry) => /\/pagefind\/index\//.test(entry.name)).length)
        if (onPage) report("search with results reads its index on the page instead of in a web worker", "/docs/")
        await context.close()
    }

    // Enter pressed while the newest query's results are still loading opens that query's first result once they arrive,
    // never a result still shown for an earlier query. The new results' page fragments are held until after Enter
    {
        const { context, page } = await openPage(wide)
        await openSearch(page)
        await page.fill(".search-dialog input", "runBot")
        await page.waitForSelector(".search-results a", { timeout: 30000 })
        let release
        const held = new Promise((resolve) => (release = resolve))
        await context.route(/\/pagefind\/fragment\//, async (route) => {
            await held
            await route.continue()
        })
        await page.fill(".search-dialog input", "members.fetch")
        await page.press(".search-dialog input", "Enter")
        release()
        const opened = await page.waitForURL(/#members-fetch$/, { timeout: 30000 }).then(() => true, () => false)
        if (!opened) report(`Enter right after typing opened ${page.url()} instead of the new query's first result`, "/docs/")
        await context.close()
    }

    // A key that confirms or chooses input-method text belongs to the input method. Enter, Escape and the arrows pressed
    // while composing, marked as such or only by key code 229, leave the dialog, its results and the page as they were
    {
        const { context, page } = await openPage(wide)
        await openSearch(page)
        await page.fill(".search-dialog input", "runBot")
        await page.waitForSelector(".search-results a", { timeout: 30000 })
        const acted = await page.evaluate(() => {
            const input = document.querySelector(".search-dialog input")
            const acted = []
            for (const marked of ["composing", "key code 229"]) {
                for (const key of ["ArrowDown", "ArrowUp", "Escape", "Enter"]) {
                    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, isComposing: marked === "composing" })
                    Object.defineProperty(event, "keyCode", { get: () => (marked === "composing" ? 13 : 229) })
                    // The dialog's own keys all take the key from the browser, so a key it acted on is a prevented one
                    if (!input.dispatchEvent(event)) acted.push(`${key} (${marked})`)
                }
            }
            return acted
        })
        if (acted.length) report(`search acts on keys an input method is composing with: ${acted.join(", ")}`, "/docs/")
        if (!(await page.locator(".search-dialog[open]").count())) report("Escape while an input method composes closes search", "/docs/")
        await context.close()
    }

    // Clearing the query and typing the last answered one again shows no nothing found before its results arrive, and an Enter
    // pressed meanwhile opens its first result. Typing and Enter happen in one turn of the page, so the results can't come first
    {
        const { context, page } = await openPage(wide)
        await openSearch(page)
        await page.fill(".search-dialog input", "runBot")
        await page.waitForSelector(".search-results a", { timeout: 30000 })
        const first = await page.locator(".search-results a").first().evaluate((link) => link.href)
        await page.fill(".search-dialog input", "")
        await page.waitForFunction(() => !document.querySelector(".search-results a"), null, { timeout: 30000 })
        const said = await page.evaluate(async () => {
            const input = document.querySelector(".search-dialog input")
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "runBot")
            input.dispatchEvent(new Event("input", { bubbles: true }))
            // React shows a typed key's change in a microtask, before any task such as the search worker's answer
            for (let turn = 0; turn < 3; turn++) await Promise.resolve()
            const said = document.querySelector(".search-status")?.textContent ?? ""
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
            return said
        })
        if (/Nothing found/.test(said)) report("search says nothing was found for the last answered query typed again before its results arrive", "/docs/")
        const opened = await page.waitForURL(first, { timeout: 30000 }).then(() => true, () => false)
        if (!opened) report(`Enter on the last answered query typed again opened ${page.url()} instead of its first result`, "/docs/")
        await context.close()
    }

    // Search's Esc button is how a phone leaves search, so a finger anywhere in the 44 px square around it presses it
    {
        const { context, page } = await openPage({ width: 320, height: 568 })
        await openSearch(page)
        const missed = await page.evaluate(() => {
            const close = document.querySelector(".search-close")
            const box = close.getBoundingClientRect()
            const [x, y] = [box.left + box.width / 2, box.top + box.height / 2]
            const reach = 21.5
            return [[-reach, -reach], [reach, -reach], [-reach, reach], [reach, reach]].filter(([dx, dy]) => !document.elementFromPoint(x + dx, y + dy)?.closest(".search-close")).length
        })
        if (missed) report("search's Esc button takes a touch under 44 px", "phone-320")
        await context.close()
    }

    // A word nobody wrote is answered as nothing found, not as a failure
    {
        const { context, page } = await openPage(wide)
        await openSearch(page)
        await page.fill(".search-dialog input", "qqzzxxnothinghere")
        await page.waitForSelector(".search-status:has-text('Nothing found')", { timeout: 30000 }).catch(() => report("a word nobody wrote never gets an answer from search", "/docs/"))
        if (await page.locator(".search-retry").count()) report("a word nobody wrote is reported as a search failure", "/docs/")
        await context.close()
    }

    // The search library loses each of its requests quietly, so each is failed in turn. Whatever fails, the reader sees it as a
    // failure, never as nothing found, and gets results again without a reload
    const failing = [
        { name: "the search script", pattern: /\/pagefind\/pagefind\.js/, query: "Snowflake" },
        { name: "the search index", pattern: /\/pagefind\/(?:[^/]*\.pf_meta|pagefind-entry\.json|index\/)/, query: "Snowflake" },
        // After an earlier answer, whose results must not stay on screen as if they answered this one
        { name: "a search result", pattern: /\/pagefind\/fragment\//, query: "Snowflake", earlier: "runBot" },
        // Only the index's word chunks, every time, while the file that says the index exists still loads
        { name: "the index's word chunks", pattern: /\/pagefind\/index\//, query: "runBot" },
    ]
    for (const { name, pattern, query, earlier } of failing) {
        const { context, page } = await openPage(wide)
        if (!earlier) await context.route(pattern, (route) => route.abort())
        await openSearch(page)
        if (earlier) {
            await page.fill(".search-dialog input", earlier)
            await page.waitForSelector(".search-results a", { timeout: 30000 })
            await context.route(pattern, (route) => route.abort())
        }
        await page.fill(".search-dialog input", query)
        const retry = await retryShown(page)
        const said = await page.evaluate(() => [...(document.querySelector(".search-status")?.childNodes ?? [])].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").trim())
        if (!said) report(`search says nothing about the failure while ${name} can't load`, "/docs/")
        if (await saysNothing(page)) report(`search says nothing was found while ${name} can't load`, "/docs/")
        if (await hits(page).count()) report(`search keeps showing results while ${name} can't load`, "/docs/")
        if (!retry) {
            report(`search shows no Retry while ${name} can't load`, "/docs/")
            await context.close()
            continue
        }
        await context.unroute(pattern)
        await page.click(".search-retry")
        if (!(await page.waitForSelector(".search-results a", { timeout: 30000 }).then(() => true, () => false))) report(`search stays broken after ${name} comes back`, "/docs/")
        await context.close()
    }

    // A tab left open across a deploy asks for files the deploy replaced. One lost index file doesn't read as nothing found
    for (const answer of [(route) => route.abort(), (route) => route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title>" })]) {
        const { context, page } = await openPage(wide)
        let lost = false
        await context.route(/\/pagefind\/index\//, (route) => {
            if (lost) return route.continue()
            lost = true
            return answer(route)
        })
        await openSearch(page)
        await page.fill(".search-dialog input", "Snowflake")
        if (!(await page.waitForSelector(".search-results a", { timeout: 30000 }).then(() => true, () => false))) report("search finds nothing after losing one index file", "/docs/")
        if (!lost) report("the check for a lost index file never lost one", "/docs/")
        await context.close()
    }

    // Search fits the window with its list full and scrolled to the end, even where the page zooms on a short wide
    // screen, and a long name in a result wraps on a narrow phone rather than running out of the list
    const searchFits = [
        ...screens.filter((screen) => ["desktop-2560-short", "ultrawide-3440-short"].includes(screen.name)).map((screen) => ({ screen, query: "message" })),
        { screen: screens.find((screen) => screen.name === "phone-320"), query: "ConnectionTimeoutError" },
    ]
    for (const { screen, query } of searchFits) {
        const { context, page } = await openPage({ width: screen.width, height: screen.height })
        await openSearch(page)
        await page.fill(".search-dialog input", query)
        if (!(await page.waitForSelector(".search-results li:nth-child(4) a", { timeout: 30000 }).then(() => true, () => false))) {
            report(`search for "${query}" shows too few results to check its layout`, screen.name)
            await context.close()
            continue
        }
        const fit = await page.evaluate(() => {
            const list = document.querySelector(".search-results")
            list.scrollTop = list.scrollHeight
            const last = list.lastElementChild.getBoundingClientRect()
            return { bottom: Math.max(document.querySelector(".search-dialog").getBoundingClientRect().bottom, last.bottom), height: innerHeight, wide: list.scrollWidth - list.clientWidth }
        })
        if (fit.bottom > fit.height + 0.5) report(`the search dialog ends ${Math.round(fit.bottom - fit.height)} px below the window`, screen.name)
        if (fit.wide > 0) report(`search results for "${query}" run ${fit.wide} px past the list`, screen.name)
        await context.close()
    }

    // A symbol's own page folds its long remarks, so on a phone its members start within a few screens, and every remark
    // is still on the page, one press away
    {
        const { context, page } = await openPage({ width: 390, height: 844 })
        await page.goto(`${site.url}/docs/api/js-ts/client/`, { waitUntil: "load" })
        const client = await page.evaluate(() => ({
            properties: document.getElementById("section-properties").getBoundingClientRect().top + scrollY,
            folded: document.querySelectorAll(".ref-fold:not([open]) .ref-prose p").length,
        }))
        if (client.properties > 3 * 844) report(`the Client page's members start ${Math.round(client.properties)} px down`, "/docs/api/js-ts/client/")
        if (!client.folded) report("the Client page has no folded remarks", "/docs/api/js-ts/client/")
        await context.close()
    }

    // Escape leaves search at once, with its query, and the reader is back on the button that opened it
    {
        const { context, page } = await openPage(wide)
        await openSearch(page)
        await page.fill(".search-dialog input", "runBot")
        await page.keyboard.press("Escape")
        const after = await page.evaluate(() => ({ open: Boolean(document.querySelector("dialog[open]")), back: document.activeElement?.matches(".search-open") }))
        if (after.open) report("Escape in search doesn't close it", "/docs/")
        else if (!after.back) report("closing search with Escape doesn't return focus to its button", "/docs/")
        await context.close()
    }

    // Reading the Effect API, a name leads to the Effect API
    {
        const { context, page } = await openPage(wide)
        for (const route of ["/docs/effect-first-bot/", "/docs/api/effect/client-and-lifecycle/"]) {
            await page.goto(site.url + route, { waitUntil: "load" })
            const links = await page.evaluate(() => [...document.querySelectorAll("a.peek-api")].filter((link) => link.textContent.trim() === "runBot").map((link) => link.getAttribute("href")))
            if (!links.length) report("no link to runBot to check", route)
            for (const link of links) if (!link.startsWith("/docs/api/effect/")) report(`runBot links to ${link}`, route)
        }

        // The Effect methods on Find a Method by Task name the Effect API too, wherever the Effect pages have the name
        await page.goto(`${site.url}/docs/api/tasks/`, { waitUntil: "load" })
        const crossing = await page.evaluate(() => {
            const effect = [...document.querySelectorAll(".ref-group")].find((group) => group.querySelector("h2")?.id === "effect")
            return effect && [...effect.querySelectorAll("dd a[href^='/docs/api/js-ts/']")].map((link) => link.getAttribute("href"))
        })
        if (!crossing) report("Find a Method by Task has no Effect section to check", "/docs/api/tasks/")
        const effectPages = new Map()
        for (const link of new Set(crossing ?? [])) {
            const [path, anchor] = link.replace("/docs/api/js-ts/", "/docs/api/effect/").split("#")
            if (!effectPages.has(path)) effectPages.set(path, await page.request.get(site.url + path).then((response) => (response.ok() ? response.text() : "")))
            // A name the Effect page only lists, as declared in the JavaScript API and documented there, rightly leads there
            const target = anchor && new RegExp(`<[^>]*\\sid="${anchor}"[^>]*>`).exec(effectPages.get(path))?.[0]
            if (target && !target.includes("ref-row")) report(`an Effect method's summary links to ${link}`, "/docs/api/tasks/")
        }

        // A default value reads as a sentence, and a nested option shows its own
        await page.goto(`${site.url}/docs/api/js-ts/options/`, { waitUntil: "load" })
        const defaults = await page.evaluate(() => {
            const notes = [...document.querySelectorAll(".ref-note")].filter((note) => note.textContent.trim().startsWith("Default"))
            return {
                nested: notes.filter((note) => note.closest(".ref-nested")).map((note) => note.textContent.replace(/\s+/g, " ").trim()),
                empty: notes.filter((note) => note.textContent.trim() === "Default").length,
                framed: notes.filter((note) => note.nextElementSibling?.matches("figure, .code-frame") || note.querySelector("figure")).length,
            }
        })
        if (!defaults.nested.includes("Default 30000")) report("the nested startup option shows no default of 30000", "/docs/api/js-ts/options/")
        if (defaults.empty) report(`${defaults.empty} defaults show the word with no value`, "/docs/api/js-ts/options/")
        if (defaults.framed) report(`${defaults.framed} defaults sit in a code frame`, "/docs/api/js-ts/options/")

        // The page tells a reader to search for a code's first part, so every family's first part has to be there
        await page.goto(`${site.url}/docs/codes/`, { waitUntil: "load" })
        const shown = await page.evaluate(() => document.querySelector(".ref").textContent)
        const codes = JSON.parse(await readFile("content/reference/codes.json", "utf8"))
        for (const { code } of [...codes.errors, ...codes.logs]) if (!shown.includes(code.split(".")[0])) report(`the first part of ${code} isn't on the page`, "/docs/codes/")

        // A guide read on its own says which version it describes
        const guide = await page.request.get(`${site.url}/docs/quick-start.md`).then((response) => response.text())
        if (!/^.*version \d+\.\d+\.\d+.*$/m.test(guide.split("\n").slice(0, 6).join("\n"))) report("a copied guide doesn't name its SDK version", "/docs/quick-start.md")
        await context.close()
    }

    // The open phone menu keeps keyboard focus inside it, keeps search working, and gives the page back when it ends
    {
        const { context, page } = await openPage({ width: 390, height: 844 })
        await page.goto(`${site.url}/docs/quick-start/`, { waitUntil: "load" })
        const held = () => page.evaluate(() => [...document.querySelectorAll("body > *, body > * > *")].filter((element) => element.hasAttribute("inert") && !element.closest("[aria-hidden=true]")).length)
        const before = await held()
        await page.click("[data-side-open]")
        await page.waitForSelector("[data-side][data-open]")
        for (let press = 0; press < 80; press += 1) {
            await page.keyboard.press("Tab")
            const place = await page.evaluate(() => {
                const active = document.activeElement
                return !active || active === document.body || active.closest("[data-side]") ? "" : active.className?.toString() || active.tagName
            })
            if (place) {
                report(`keyboard focus leaves the open phone menu for ${place}`, "/docs/quick-start/")
                break
            }
        }
        await page.click(".docs-side .search-open")
        await page.fill(".search-dialog input", "Snowflake")
        if (!(await page.waitForSelector(".search-results a", { timeout: 30000 }).then(() => true, () => false))) report("search doesn't work from the open phone menu", "/docs/quick-start/")
        // Escape in the search box leaves search only, and the menu stays open behind it
        await page.press(".search-dialog input", "Escape")
        await page.waitForFunction(() => !document.querySelector("dialog[open]"))
        if (!(await page.evaluate(() => Boolean(document.querySelector("[data-side][data-open]")) && document.activeElement?.matches(".docs-side .search-open")))) {
            report("Escape in search also closes the phone menu", "/docs/quick-start/")
            if (!(await page.$("[data-side][data-open]"))) await page.click("[data-side-open]")
        }
        await page.click(".docs-side .search-open")
        await page.click(".search-close")
        await page.waitForFunction(() => !document.querySelector("dialog[open]"))
        await page.keyboard.press("Escape")
        await page.waitForFunction(() => !document.querySelector("[data-side][data-open]"))
        if (!(await page.evaluate(() => document.activeElement?.matches("[data-side-open]")))) report("closing the phone menu doesn't return focus to its button", "/docs/quick-start/")
        if ((await held()) !== before) report("closing the phone menu leaves the page out of reach", "/docs/quick-start/")

        // A tap beside the sheet closes it
        await page.click("[data-side-open]")
        await page.waitForSelector("[data-side][data-open]")
        await page.mouse.click(380, 500)
        if (!(await page.waitForFunction(() => !document.querySelector("[data-side][data-open]"), null, { timeout: 5000 }).then(() => true, () => false))) report("a tap beside the phone menu doesn't close it", "/docs/quick-start/")
        if ((await held()) !== before) report("a tap beside the phone menu leaves the page out of reach", "/docs/quick-start/")

        // A window that grows past the sheet's width ends it
        await page.click("[data-side-open]")
        await page.waitForSelector("[data-side][data-open]")
        await page.setViewportSize({ width: 1366, height: 768 })
        if (!(await page.waitForFunction(() => !document.querySelector("[data-side][data-open]"), null, { timeout: 5000 }).then(() => true, () => false))) report("a window that grows keeps the phone menu open", "/docs/quick-start/")
        if ((await held()) !== before) report("a window that grows leaves the page out of reach", "/docs/quick-start/")
        await context.close()
    }
})

serial("pages", ["/", "/logs/", "/results/", "/no-such-page/"], async () => {
    // Nothing in a log panel scrolls, so all of its text has to fit
    for (const width of [320, 390]) {
        const { context, page } = await openPage({ width, height: 800, touch: true })
        for (const route of ["/logs/", "/results/"]) {
            await page.goto(site.url + route, { waitUntil: "load" })
            const cut = await page.evaluate(() => {
                const over = []
                const range = document.createRange()
                for (const panel of document.querySelectorAll(".log-panel")) {
                    const edge = panel.getBoundingClientRect().right
                    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT)
                    while (walker.nextNode()) {
                        if (!walker.currentNode.textContent.trim()) continue
                        range.selectNodeContents(walker.currentNode)
                        const right = Math.max(...[...range.getClientRects()].map((rect) => rect.right))
                        if (right > edge + 0.5) over.push(`${walker.currentNode.textContent.trim().slice(0, 30)} by ${Math.round(right - edge)} px`)
                    }
                }
                return over
            })
            for (const text of cut) report(`a log panel cuts off text: ${text}`, `${width} ${route}`)
        }
        await context.close()
    }

    // The missing page fills one screen with whatever height its footer wraps to, without a scroll or a gap
    for (const size of [{ width: 900, height: 700 }, { width: 1100, height: 700 }, { width: 1366, height: 768 }, { width: 2560, height: 1440 }]) {
        const { context, page } = await openPage(size)
        await page.goto(`${site.url}/no-such-page/`, { waitUntil: "load" })
        await page.waitForFunction(() => document.querySelector("[data-lost]")?.style.getPropertyValue("--footer"), null, { timeout: 10000 }).catch(() => {})
        const fit = await page.evaluate(() => ({ page: document.documentElement.scrollHeight, screen: innerHeight }))
        if (fit.page > fit.screen + 1) report(`the missing page scrolls by ${fit.page - fit.screen} px`, `${size.width}x${size.height}`)
        await context.close()
    }

    const { context, page } = await openPage({ width: 1366, height: 768 }, "immersive")
    await page.goto(`${site.url}/`, { waitUntil: "load" })

    // The demo runs one message at a time, and Send says so
    await page.locator(".fr-input").scrollIntoViewIfNeeded()
    await page.waitForFunction(() => Object.keys(document.querySelector(".fr-input")).some((key) => key.startsWith("__react")), null, { timeout: 30000 })
    await page.fill(".fr-input", "!ping")
    // Watched from inside the page, since a slow runner can let the whole run end between two of this script's steps. React
    // writes busy and disabled in one commit, so each change seen here has both. The draft stays after Send, so only busy can
    // turn the button off
    await page.evaluate(() => {
        const send = document.querySelector(".fr-send")
        const seen = (window.sendSeen = { busy: false, busyOn: false })
        new MutationObserver(() => {
            if (send.dataset.busy === undefined) return
            seen.busy = true
            if (!send.disabled) seen.busyOn = true
        }).observe(send, { attributes: true, attributeFilter: ["data-busy", "disabled"] })
    })
    await page.click(".fr-send")
    await page.waitForFunction(() => window.sendSeen.busy, null, { timeout: 10000 }).catch(() => {})
    await page.waitForSelector(".fr-send:not([data-busy])", { timeout: 30000 })
    const sendSeen = await page.evaluate(() => window.sendSeen)
    if (!sendSeen.busy) report("Send never shows the demo running", "/")
    if (sendSeen.busyOn) report("Send looks available while the demo runs", "/")
    if (await page.locator(".fr-send").isDisabled()) report("Send stays off after the demo ends", "/")

    // The install menu's choices follow the arrow keys, in both groups
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }))
    await page.click("[data-pick]")
    await page.locator('[data-group="pm"] input:checked').focus()
    const pmBefore = await page.locator('[data-group="pm"] input:checked').inputValue()
    await page.keyboard.press("ArrowRight")
    const pmAfter = await page.evaluate(() => ({ focused: document.activeElement.value, checked: document.querySelector('[data-group="pm"] input:checked').value, command: document.querySelector("[data-waterline] [data-tool]").textContent }))
    if (pmAfter.checked === pmBefore || pmAfter.focused !== pmAfter.checked) report("the install menu's package managers ignore the arrow keys", "/")
    if (!pmAfter.command.startsWith(pmAfter.checked)) report("an arrow key changes the package manager without changing the command", "/")
    await page.locator('[data-group="mode"] input:checked').focus()
    await page.keyboard.press("ArrowRight")
    const modeAfter = await page.evaluate(() => ({ focused: document.activeElement.value, checked: document.querySelector('[data-group="mode"] input:checked').value }))
    if (modeAfter.checked !== "init" || modeAfter.focused !== "init") report("the install menu's commands ignore the arrow keys", "/")
    await context.close()
})

const chosen = groups.map((name) => parts.get(name)).filter((check) => (!only || only.includes(check.name)) && check.pages.some(covers))
if (chosen.length === 0) {
    console.log("No screen check covers the changed files")
    process.exit(0)
}
const site = await serveSite()
// BROWSERS starts that many browsers and hands out contexts in turn. Software drawing goes through each browser's one GPU
// process, so a few browsers can share a machine with many cores better than one
const browsers = await Promise.all(Array.from({ length: Number(process.env.BROWSERS) || 1 }, () => launchBrowser(site.url)))
let opened = 0
const seconds = () => Math.round((Date.now() - started) / 1000)
// Says which parts are on, so a long run is never silent. A part that stops on an error fails the run and the others go on
const outcomes = await Promise.allSettled(
    chosen.map((check) =>
        running.run(check, async () => {
            console.log(`${check.name}: starting at ${seconds()} s`)
            await check.work(check.pages)
            console.log(`${check.name}: done at ${seconds()} s`)
        }),
    ),
)
outcomes.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") return
    console.error(outcome.reason)
    report(`the ${chosen[index].name} check stopped: ${String(outcome.reason?.message ?? outcome.reason).split("\n")[0]}`, chosen[index].name)
})
await Promise.all(browsers.map((browser) => browser.close()))
site.close()

const ran = chosen.length < groups.length ? `, ${chosen.map((check) => check.name).join(", ")}` : ""
if (found.size === 0) {
    console.log(`Sweep clean: ${sizes.length} screens${ran}`)
} else {
    console.log(`Sweep found ${found.size} kinds of problem across ${sizes.length} screens`)
    for (const [rule, where] of [...found].sort((a, b) => b[1].size - a[1].size)) {
        const places = [...where]
        console.log(`[${places.length}] ${rule}: ${places.slice(0, 6).join(" | ")}${places.length > 6 ? " ..." : ""}`)
    }
    process.exitCode = 1
}
