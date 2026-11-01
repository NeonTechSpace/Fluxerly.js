import { launchBrowser } from "./lib.mjs"

// The quick look for one change: open a page at one size in the Still mode, print the boxes of what you name and save one
// screenshot, in a few seconds. Run pnpm check:ui once, when a round of changes is done.
// Usage: node scripts/checks/look.mjs <path> <out.png> [width]x[height] [css selectors...]
// Example: node scripts/checks/look.mjs /docs/ docs.png 2560x1376 .docs-title .pager-link
const [path = "/", out = "look.png", size = "2560x1376", ...selectors] = process.argv.slice(2)
const [width, height] = size.split("x").map(Number)
const base = process.env.LOOK_URL || "http://localhost:4321"

const browser = await launchBrowser(base)
const page = await browser.newPage({ viewport: { width, height } })
const failed = []
page.on("pageerror", (error) => failed.push(error.message))
page.on("response", (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`)
})
await page.addInitScript(() => localStorage.setItem("fluxerly.experience.v1", "still"))
await page.goto(base + path, { waitUntil: "load" })
await page.waitForTimeout(1200)
for (const selector of selectors) {
    const boxes = await page.$$eval(selector, (all) =>
        all.slice(0, 6).map((element) => {
            const box = element.getBoundingClientRect()
            return [box.left, box.top, box.width, box.height].map(Math.round).join(" ")
        }),
    )
    console.log(selector, boxes.length ? boxes.join(" | ") : "not found")
}
await page.screenshot({ path: out })
console.log(out, failed.length ? `problems: ${failed.join(" | ")}` : "no failed requests or page errors")
await browser.close()
