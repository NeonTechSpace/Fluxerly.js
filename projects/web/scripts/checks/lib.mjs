import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, resolve } from "node:path"
import { chromium } from "playwright"

// What the UI checks share: the built site on a local server, and a browser. CHECK_BROWSER names a browser to run with the GPU. Otherwise
// Playwright's Chromium draws in software, such as in CI

const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".webp": "image/webp",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".json": "application/json",
    ".wasm": "application/wasm",
}

export function serveSite(root = resolve("dist")) {
    return new Promise((done) => {
        const server = createServer(async (request, response) => {
            let file = join(root, decodeURIComponent(new URL(request.url, "http://site").pathname))
            try {
                if ((await stat(file)).isDirectory()) file = join(file, "index.html")
            } catch {
                file = join(root, "404.html")
                response.statusCode = 404
            }
            try {
                response.setHeader("content-type", mime[extname(file)] ?? "application/octet-stream")
                response.end(await readFile(file))
            } catch {
                response.statusCode = 404
                response.end()
            }
        })
        server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }))
    })
}

export async function launchBrowser(siteUrl) {
    const executablePath = process.env.CHECK_BROWSER || undefined
    const args = executablePath ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--enable-unsafe-swiftshader"]
    const browser = await chromium.launch({ executablePath, headless: true, args })
    // Some browsers reload their first page a few seconds after starting, so that first page is one nobody measures
    if (executablePath) {
        const first = await browser.newPage()
        await first.goto(`${siteUrl}/docs/`).catch(() => {})
        await first.waitForTimeout(6000)
        await first.close()
    }
    return browser
}

export const experienceKey = "fluxerly.experience.v1"
export const tourKey = "fluxerly.tour.v1"
export const skyIconsKey = "fluxerly.sky-icons.v1"

// The screens every check covers. Browser bars are taken off the heights. The folding phones' sizes come from reported
// specs and are approximate
export const screens = [
    { name: "phone-320", width: 320, height: 568, touch: true },
    { name: "phone-360", width: 360, height: 640, touch: true },
    { name: "phone-360-tall", width: 360, height: 740, touch: true },
    { name: "phone-375", width: 375, height: 667, touch: true },
    { name: "phone-384", width: 384, height: 800, touch: true },
    { name: "phone-390", width: 390, height: 844, touch: true, quick: true },
    { name: "phone-412", width: 412, height: 915, touch: true },
    { name: "phone-430", width: 430, height: 932, touch: true },
    { name: "phone-320-sideways", width: 568, height: 320, touch: true },
    { name: "phone-360-sideways", width: 640, height: 340, touch: true },
    { name: "phone-375-sideways", width: 667, height: 320, touch: true },
    { name: "phone-360-tall-sideways", width: 740, height: 340, touch: true },
    { name: "phone-390-sideways", width: 844, height: 340, touch: true, quick: true },
    { name: "phone-412-sideways", width: 915, height: 370, touch: true },
    { name: "phone-430-sideways", width: 932, height: 390, touch: true },
    { name: "fold-narrow-cover", width: 344, height: 790, touch: true },
    { name: "fold-narrow-cover-sideways", width: 790, height: 344, touch: true },
    { name: "fold-cover", width: 416, height: 600, touch: true, quick: true },
    { name: "fold-cover-sideways", width: 657, height: 370, touch: true },
    // Measured on a Galaxy Z Fold 8 Ultra in Chrome, both screens
    { name: "fold-8-ultra-main", width: 859, height: 800, touch: true, quick: true, dpr: 2.625 },
    { name: "fold-8-ultra-main-sideways", width: 800, height: 859, touch: true, dpr: 2.625 },
    { name: "fold-8-ultra-cover", width: 411, height: 846, touch: true, dpr: 2.625 },
    { name: "fold-open", width: 704, height: 840, touch: true, quick: true },
    { name: "fold-open-sideways", width: 933, height: 640, touch: true },
    { name: "fold-tall-open", width: 750, height: 750, touch: true },
    { name: "fold-tall-open-sideways", width: 832, height: 670, touch: true },
    { name: "iphone-fold-cover", width: 440, height: 570, touch: true },
    { name: "iphone-fold-cover-sideways", width: 653, height: 390, touch: true },
    { name: "iphone-fold-open", width: 640, height: 820, touch: true },
    { name: "iphone-fold-open-sideways", width: 904, height: 580, touch: true },
    { name: "tablet-600", width: 600, height: 960, touch: true },
    { name: "tablet-600-sideways", width: 960, height: 540, touch: true },
    { name: "tablet-768", width: 768, height: 1024, touch: true },
    { name: "tablet-768-sideways", width: 1024, height: 700, touch: true },
    { name: "tablet-820", width: 820, height: 1180, touch: true, quick: true },
    { name: "tablet-820-sideways", width: 1180, height: 760, touch: true },
    { name: "tablet-1024", width: 1024, height: 1366, touch: true },
    { name: "tablet-1024-sideways", width: 1366, height: 960, touch: true },
    { name: "laptop-1024", width: 1024, height: 500 },
    { name: "laptop-1280-short", width: 1280, height: 560 },
    { name: "laptop-1280", width: 1280, height: 640 },
    { name: "laptop-1280-tall", width: 1280, height: 720 },
    { name: "laptop-1366-short", width: 1366, height: 600, quick: true },
    { name: "laptop-1366", width: 1366, height: 660 },
    { name: "laptop-1440", width: 1440, height: 780 },
    { name: "laptop-1512", width: 1512, height: 860 },
    { name: "laptop-1536", width: 1536, height: 730 },
    { name: "laptop-1600", width: 1600, height: 790 },
    { name: "laptop-1680", width: 1680, height: 930 },
    { name: "desktop-1920-short", width: 1920, height: 640 },
    { name: "desktop-1920", width: 1920, height: 940, quick: true },
    { name: "desktop-1920-full", width: 1920, height: 1080 },
    { name: "desktop-2400", width: 2400, height: 1200 },
    { name: "desktop-2560-short", width: 2560, height: 800 },
    { name: "desktop-2560", width: 2560, height: 1300, quick: true },
    { name: "ultrawide-2560", width: 2560, height: 960 },
    { name: "ultrawide-3440", width: 3440, height: 1300 },
    { name: "ultrawide-3440-short", width: 3440, height: 1000 },
    { name: "desktop-3840", width: 3840, height: 2000 },
    { name: "ultrawide-5120", width: 5120, height: 1300 },
    { name: "upright-1080", width: 1080, height: 1800 },
    { name: "upright-1200", width: 1200, height: 1800 },
    { name: "upright-1440", width: 1440, height: 2400 },
    { name: "upright-2160", width: 2160, height: 3700 },
]
