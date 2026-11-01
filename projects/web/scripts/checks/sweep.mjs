import { globSync } from "node:fs"
import os from "node:os"
import { resolve } from "node:path"
import { titleCase } from "../../src/lib/title-case.ts"
import { experienceKey, launchBrowser, screens, serveSite, tourKey } from "./lib.mjs"

// The whole site at every screen in lib.mjs: layout on each kind of page, the first visit's spotlight, menus, titles on
// every page, and icons over text while scrolling. Fails with a list of what it found. Usage:
// node scripts/checks/sweep.mjs [--quick] [--only=layout,tour,parts,install,menus,titles,scroll,alive,questions]
// --quick covers a few screens of each kind. Reads the built site, so run it after a build
const flags = process.argv.slice(2)
const quick = flags.includes("--quick")
const only = flags.find((flag) => flag.startsWith("--only="))?.slice(7).split(",")
const started = Date.now()
// Says which part it is on, so a long run is never silent
const runs = (part) => {
    const on = !only || only.includes(part)
    if (on) console.log(`${part}: starting at ${Math.round((Date.now() - started) / 1000)} s`)
    return on
}
const sizes = quick ? screens.filter((screen) => screen.quick) : screens
const routes = ["/", "/commands/", "/effect/", "/first-reply/", "/docs/", "/docs/commands/", "/docs/api/", "/docs/api/tasks/", "/docs/api/endpoints/", "/docs/codes/", "/does-not-exist/"]
// WORKERS overrides the default worker count, which is 80% of logical CPUs rounded down, with a minimum of one
const workers = Math.max(1, Number(process.env.WORKERS) || Math.floor(os.cpus().length * 0.8))

const blankPicture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
const site = await serveSite()
const browser = await launchBrowser(site.url)
const found = new Map()
const report = (rule, where) => {
    if (!found.has(rule)) found.set(rule, new Set())
    found.get(rule).add(where)
}

const inParallel = async (jobs, work) => {
    let next = 0
    await Promise.all(
        Array.from({ length: workers }, async () => {
            while (next < jobs.length) await work(jobs[next++])
        }),
    )
}

const openPage = async ({ width, height, touch, dpr }, mode = "still", tour = false) => {
    // A phone's browser, with a coarse pointer, so the touch rules apply as they do on a device
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: Boolean(touch), isMobile: Boolean(touch), deviceScaleFactor: dpr ?? 1 })
    const page = await context.newPage()
    page.on("pageerror", (error) => report(`page error: ${error.message.slice(0, 120)}`, `${width}x${height}`))
    if (mode) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [experienceKey, mode])
    if (!tour) await page.addInitScript((key) => localStorage.setItem(key, "1"), tourKey)
    return { context, page }
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

if (runs("layout")) {
    // One page for each route and kind of device, resized through every screen, and a blank picture for each picture: they
    // have their sizes in the markup. Reloading every route for every screen was most of this check's time. The tour part
    // below still loads the homepage fresh on every screen
    const kinds = [...new Set(sizes.map((screen) => `${Boolean(screen.touch)}|${screen.dpr ?? 1}`))].map((kind) => sizes.filter((screen) => `${Boolean(screen.touch)}|${screen.dpr ?? 1}` === kind))
    await inParallel(
        routes.flatMap((route) => kinds.map((screens) => ({ route, screens }))),
        async ({ route, screens }) => {
            const { context, page } = await openPage(screens[0])
            await context.route(/\.(webp|png|jpg)(\?|$)/, (request) => request.fulfill({ contentType: "image/png", body: blankPicture }))
            await page.goto(site.url + route, { waitUntil: "load" })
            await page.waitForTimeout(250)
            for (const screen of screens) {
                await page.setViewportSize({ width: screen.width, height: screen.height })
                await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 120)))))
                for (const problem of await page.evaluate(auditLayout, Boolean(screen.touch))) report(problem, `${screen.name} ${route}`)
            }
            await context.close()
        },
    )
}

if (runs("tour")) {
    // A first visit on each screen: the tip shows, around the switch, whole on the screen and goes for good
    const entries = ["/", "/docs/commands/", "/does-not-exist/"]
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
        await page.waitForTimeout(500)
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
        await page.reload({ waitUntil: "load" })
        await page.waitForTimeout(1500)
        if (await page.evaluate(() => Boolean(document.querySelector(".tour:popover-open")))) report("first visit tip came back", where)
        await context.close()
    })
}

if (runs("parts")) {
    // A multi-part icon at rest, with its shadow, must look like the whole picture it takes over from, on the page, not only on its own
    const screen = sizes.find((candidate) => !candidate.touch && candidate.width >= 1280) ?? sizes[0]
    const pages = ["/", "/commands/", "/effect/", "/first-reply/", "/testing/", "/production/", "/data/", "/results/", "/logs/"]
    await inParallel(pages, async (route) => {
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
            await page.waitForTimeout(120)
            const box = await figure.boundingBox()
            if (!box) continue
            const clip = { x: Math.max(0, box.x - box.width * 0.3), y: Math.max(0, box.y - box.height * 0.3), width: box.width * 1.6, height: box.height * 1.6 }
            const parts = await page.screenshot({ clip })
            await figure.evaluate((element) => delete element.dataset.live)
            await page.waitForTimeout(120)
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
}

if (runs("install")) {
    // The hero's install menu, open: every option on the screen, inside the hero, under the finger and big enough for it
    await inParallel(sizes, async (screen) => {
        const { context, page } = await openPage(screen)
        await context.route(/\.(webp|png|jpg)(\?|$)/, (request) => request.fulfill({ contentType: "image/png", body: blankPicture }))
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        await page.click("[data-waterline] .pick", { force: true })
        await page.waitForTimeout(350)
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
                if (box.left < 0 || box.right > innerWidth || box.top < Math.max(0, hero.top) || box.bottom > Math.min(innerHeight, hero.bottom)) list.push(`install menu: ${name} is cut off`)
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
            await page.click(`[data-menu] [data-group="mode"] [data-value="${command}"]`, { force: true })
            await page.waitForTimeout(120)
            for (const problem of await page.evaluate(audit, Boolean(screen.touch))) report(problem, `${screen.name} ${command}`)
            // Closed and opened again with that command, and the next one picked from there
            await page.click("[data-waterline] .pick", { force: true })
            await page.click("[data-waterline] .pick", { force: true })
            await page.waitForTimeout(120)
            for (const problem of await page.evaluate(audit, Boolean(screen.touch))) report(problem, `${screen.name} ${command}, reopened`)
        }
        await context.close()
    })
}

if (runs("menus")) {
    await inParallel(sizes, async (screen) => {
        const { context, page } = await openPage(screen)
        await page.goto(`${site.url}/docs/commands/`, { waitUntil: "load" })
        await page.waitForFunction(() => !document.querySelector("astro-island[ssr]"), null, { timeout: 15000 })
        const trigger = await page.$("header .trigger")
        if (trigger && (await trigger.isVisible())) {
            await trigger.click({ force: true })
            await page.waitForTimeout(350)
            const problem = await page.evaluate(() => {
                const panel = [...document.querySelectorAll("header .panel")].find((element) => element.getBoundingClientRect().width > 0)
                if (!panel) return "did not open"
                const rect = panel.getBoundingClientRect()
                return rect.right > innerWidth + 1 || rect.left < -1 ? "off screen" : ""
            })
            if (problem) report(`Discover menu ${problem}`, screen.name)
            await page.keyboard.press("Escape")
            await page.waitForTimeout(150)
        } else report("Discover button missing", screen.name)
        await page.keyboard.press("Control+k")
        await page.waitForTimeout(450)
        const search = await page.evaluate(() => {
            const input = [...document.querySelectorAll("input")].find((element) => element.offsetWidth > 0 && /search/i.test(`${element.placeholder}${element.type}${element.getAttribute("aria-label") ?? ""}`))
            if (!input) return "did not open"
            const rect = input.getBoundingClientRect()
            return rect.right > innerWidth + 1 || rect.left < -1 || rect.top < -1 || rect.bottom > innerHeight + 1 ? "off screen" : ""
        })
        if (search) report(`search ${search}`, screen.name)
        await context.close()
    })
}

if (runs("titles")) {
    const pages = globSync("**/index.html", { cwd: resolve("dist") }).map((file) => {
        const folder = file.split(/[\\/]/).slice(0, -1).join("/")
        return folder ? `/${folder}/` : "/"
    })
    const { context: titleContext } = await openPage({ width: 1440, height: 900 })
    await titleContext.route(/\.(webp|png|jpg)(\?|$)/, (request) => request.fulfill({ contentType: "image/png", body: blankPicture }))
    await inParallel([...pages, "/404.html"], async (route) => {
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
}

if (runs("scroll")) {
    // Scrolling a whole page in motion is slow, and icons pass the words the same way on neighboring sizes, so a spread will do
    const wide = sizes.filter((screen) => screen.width >= 900).filter((screen, index) => quick || index % 3 === 0)
    await inParallel(
        wide.flatMap((screen) => ["/", "/commands/"].map((route) => ({ screen, route }))),
        async ({ screen, route }) => {
            const { context, page } = await openPage(screen, "immersive")
            await page.goto(site.url + route, { waitUntil: "load" })
            await page.waitForTimeout(1000)
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
}

if (runs("alive")) {
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
        await page.waitForTimeout(600)
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

    // A click right after hovering opened the Discover menu is a reflex and leaves it open. A later click closes it
    {
        const { context, page } = await openPage(screen, "immersive")
        await page.goto(`${site.url}/commands/`, { waitUntil: "load" })
        const trigger = page.locator("[data-discover-trigger]")
        const open = () => trigger.getAttribute("aria-expanded")
        await trigger.hover()
        await page.waitForFunction(() => document.querySelector("[data-discover-trigger]").getAttribute("aria-expanded") === "true")
        await trigger.click()
        if ((await open()) !== "true") report("a reflex click closes the Discover menu that hovering just opened", "/commands/")
        await page.waitForTimeout(900)
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

    // The light on the page end's black hole stays on the rim that is painted. With its head where the hole has no rim, it adds nothing
    const { context, page } = await openPage(screen, "immersive")
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
    const headBelow = await page.evaluate(() => {
        for (const animation of document.getAnimations()) animation.pause()
        const [turning] = document.querySelector(".hole-ring").getAnimations()
        turning.currentTime = (turning.effect.getTiming().duration * 200) / 360
        return true
    })
    const box = headBelow && (await page.locator(".hole-rim").boundingBox())
    const picture = async () => sharp(await page.screenshot({ clip: box })).removeAlpha().raw().toBuffer()
    await page.waitForTimeout(150)
    const lit = await picture()
    await page.addStyleTag({ content: ".hole-ring{visibility:hidden!important}" })
    await page.waitForTimeout(150)
    const dark = await picture()
    let added = 0
    for (let i = 0; i < lit.length; i++) added += Math.abs(lit[i] - dark[i])
    if (added / lit.length > 0.4) report(`the black hole's light runs where no rim is painted: ${(added / lit.length).toFixed(1)} levels`, "/")
    await context.close()
}

if (runs("questions")) {
    await inParallel(sizes.filter((size) => size.quick || size.width === 390), async (size) => {
        const { context, page } = await openPage(size, "immersive")
        await page.goto(`${site.url}/`, { waitUntil: "load" })
        await page.waitForTimeout(800)
        const result = await page.evaluate(async () => {
            const items = [...document.querySelectorAll("#questions details.item")]
            const wait = (ms) => new Promise((done) => setTimeout(done, ms))
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
            const summaryOf = (index) => items[index].querySelector("summary")
            const answer = getComputedStyle(items[1], "::details-content")
            const glides = getComputedStyle(items[1]).interpolateSize === "allow-keywords" && answer.transitionProperty.split(", ").includes("height") && parseFloat(answer.transitionDuration) > 0

            // Nothing open above: the pressed question stays where it is
            summaryOf(0).scrollIntoView({ block: "center", behavior: "instant" })
            await settled(summaryOf(0))
            const firstTop = summaryOf(0).getBoundingClientRect().top
            summaryOf(0).click()
            await wait(50)
            await settled(summaryOf(0))
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
                await wait(50)
                await settled(summary)
                const after = summary.getBoundingClientRect().top
                // At the header the page has to follow, so only a question clear of it counts
                if (after > 100) pageMoved = Math.max(pageMoved, Math.abs(scrollY - y))
                sank = Math.max(sank, after - top)
            }

            // A long answer above and the next question near the top: it stays clear of the header instead of leaving the screen
            summaryOf(0).click()
            await wait(50)
            await settled(summaryOf(0))
            summaryOf(1).scrollIntoView({ block: "start", behavior: "instant" })
            window.scrollBy({ top: -100, behavior: "instant" })
            await settled(summaryOf(1))
            summaryOf(1).click()
            await wait(50)
            await settled(summaryOf(1))
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
            await wait(600)
            const scrolled = before - other.getBoundingClientRect().top

            // Deep in the list with the heading pinned: opening an answer leaves the signal line above it alone
            const lineAbove = () => {
                const index = [...document.querySelectorAll("[data-station]")].indexOf(document.querySelector('[data-station="questions"]'))
                const station = document.querySelectorAll(".thread-stations .station")[index]
                return { station, place: station?.getAttribute("transform"), bead: document.querySelector("[data-beads] .bead"), line: document.querySelector("[data-thread-line]").getAttribute("d").split(" L ")[0] }
            }
            const deep = summaryOf(items.length - 1)
            deep.scrollIntoView({ block: "center", behavior: "instant" })
            await settled(deep)
            await wait(300)
            const lineBefore = lineAbove()
            deep.click()
            await wait(50)
            await settled(deep)
            await wait(300)
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
}

await browser.close()
site.close()

if (found.size === 0) {
    console.log(`Sweep clean: ${sizes.length} screens`)
} else {
    console.log(`Sweep found ${found.size} kinds of problem across ${sizes.length} screens`)
    for (const [rule, where] of [...found].sort((a, b) => b[1].size - a[1].size)) {
        const places = [...where]
        console.log(`[${places.length}] ${rule}: ${places.slice(0, 6).join(" | ")}${places.length > 6 ? " ..." : ""}`)
    }
    process.exitCode = 1
}
