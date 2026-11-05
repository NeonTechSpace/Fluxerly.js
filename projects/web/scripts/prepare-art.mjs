// Builds the web derivatives in public/art from the accepted originals in art-source: the mascot's parts in mascot/layers,
// its finished picture in mascot, the icons in icons and the social preview. Only the originals this script reads are kept there.
// The originals stay untouched. Run with: pnpm prepare:art
// Name steps to run only those, for example: pnpm prepare:art face icons

import sharp from "sharp"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const art = (name) => fileURLToPath(new URL(`../public/art/${name}`, import.meta.url))
const originals = fileURLToPath(new URL("../art-source/", import.meta.url))
const layer = (name) => `${originals}mascot/layers/${name}.png`
const family = `${originals}icons/`
const finished = `${originals}mascot/mascot-faceted-conductor.png`

const canvas = 2048
// Tight box around the visible mascot inside the 2048 canvas, with a small margin.
// src/lib/art.ts mirrors these numbers.
const crop = { left: 450, top: 98, width: 1168, height: 1676 }
const webp = (quality) => ({ quality, alphaQuality: 100, effort: 6, smartSubsample: true })
const rawCanvas = { width: canvas, height: canvas, channels: 4 }

const pixels = async (input) => (await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data
const png = (data, raw = rawCanvas) => sharp(data, { raw }).png().toBuffer()

// The PSD's layers bottom to top, with the blend mode of each. Stacked they reproduce the finished
// picture to within one level, so a stack that leaves a part out is the mascot without that part
const stack = [
    { name: "frame" },
    { name: "atmosphere" },
    { name: "black-hole" },
    { name: "eyes" },
    { name: "brow-cyan" },
    { name: "brow-violet" },
    { name: "waves" },
    { name: "crescents" },
    { name: "glass-reflections", screen: true },
    { name: "cap" },
    { name: "bow" },
]

async function stacked(without = []) {
    const out = new Float32Array(canvas * canvas * 4)
    for (const { name, screen } of stack) {
        if (without.includes(name)) continue
        const data = await pixels(layer(name))
        for (let i = 0; i < out.length; i += 4) {
            const a = data[i + 3] / 255
            if (a === 0) continue
            const under = out[i + 3]
            const alpha = a + under * (1 - a)
            for (let c = 0; c < 3; c++) {
                let top = data[i + c] / 255
                const low = out[i + c]
                if (screen) top = (top + low - top * low) * under + top * (1 - under)
                out[i + c] = (top * a + low * under * (1 - a)) / alpha
            }
            out[i + 3] = alpha
        }
    }
    const bytes = Buffer.alloc(out.length)
    for (let i = 0; i < out.length; i++) bytes[i] = Math.round(Math.min(1, out[i]) * 255)
    return bytes
}

// What a part adds to the picture, as a layer that gives the whole mascot again over the mascot without it:
// the least alpha that reaches each pixel, then the color at that alpha. So a part lifted off and put back
// lands exactly, whatever lies above it in the PSD and however it was blended
async function lifted(names) {
    const whole = await stacked()
    const under = await stacked(names)
    const part = Buffer.alloc(whole.length)
    for (let i = 0; i < whole.length; i += 4) {
        if (whole[i + 3] === 0) continue
        let alpha = 0
        for (let c = 0; c < 3; c++) {
            const to = whole[i + c]
            const from = under[i + c]
            alpha = Math.max(alpha, to > from ? (to - from) / (255 - from) : to < from ? (from - to) / from : 0)
        }
        if (alpha < 1 / 255) continue
        for (let c = 0; c < 3; c++) part[i + c] = Math.round(Math.min(255, Math.max(0, (whole[i + c] - (1 - alpha) * under[i + c]) / alpha)))
        part[i + 3] = Math.round(alpha * whole[i + 3])
    }
    return png(part)
}

const waves = () => lifted(["waves"])

// Bakes a soft cyan halo under the strokes, so the page needs no CSS filter at hover time
async function withHalo(strokes) {
    const { data, info } = await sharp(strokes).raw().toBuffer({ resolveWithObject: true })
    const halo = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i += 4) {
        halo[i] = 70
        halo[i + 1] = 227
        halo[i + 2] = 239
        halo[i + 3] = Math.round(data[i + 3] * 0.8)
    }
    const blurred = await sharp(halo, { raw: info }).blur(16).png().toBuffer()
    return sharp(blurred).composite([{ input: strokes }]).png().toBuffer()
}

async function writeSizes(source, name, quality, widths = [crop.width, crop.width / 2]) {
    const trimmed = await sharp(source).extract(crop).png().toBuffer()
    for (const width of widths) {
        const height = Math.round((crop.height * width) / crop.width)
        const file = art(`${name}-${width}.webp`)
        await sharp(trimmed).resize(width, height, { kernel: "lanczos3" }).webp(webp(quality)).toFile(file)
        console.log(`wrote ${name}-${width}.webp (${width}x${height})`)
    }
}

// The icons the site places, by name. src/lib/art.ts lists the same names. Each is trimmed to what it draws and
// keeps a little clear margin, so texture filtering never clips its edge. It comes at the sizes the site loads: 160 for the
// menu and the docs, 320 for the sky, and 640 for the sky and the sections
const icons = [
    "first-reply-radio",
    "effect-plug",
    "results-signpost",
    "commands-key",
    "logs-scroll",
    "testing-flask",
    "production-server",
    "data-database",
    "neonflux-bot",
    "roles-tags",
    "messages-plane",
    "events-bell",
    "webhook-hook",
    "announce-megaphone",
    "retry-loop",
    "cooldown-hourglass",
    "shutdown-switch",
    "deploy-balloon",
    "support-lifebuoy",
    "toolbox",
    "sdk-package",
    "star-drop",
    "guard-shield",
    "api-book",
    "permission-lock",
    "cache-disc",
    "emoji-jack",
    "config-sliders",
    "errors-beacon",
]

// The icons in the hero's sky, src/scene/companion-specs.ts, and the ones that never appear at section size
const skyIcons = new Set(["announce-megaphone", "commands-key", "deploy-balloon", "events-bell", "first-reply-radio", "messages-plane", "star-drop"])
const menuOnlyIcons = new Set(["config-sliders", "emoji-jack", "permission-lock", "roles-tags", "webhook-hook"])

// An icon's whole picture: a multi-part icon keeps it in a folder of its own, with its parts
async function wholeIcon(slug) {
    const files = await readdir(family)
    const folder = files.find((name) => name.endsWith(`-${slug}`))
    if (folder) return `${family}${folder}/${folder}.png`
    const file = files.find((name) => name.endsWith(`-${slug}.png`))
    if (!file) throw new Error(`No icon named ${slug}`)
    return `${family}${file}`
}

async function writeIcons() {
    await mkdir(art("icons"), { recursive: true })
    for (const slug of icons) {
        const cut = await sharp(await wholeIcon(slug)).trim({ threshold: 0 }).png().toBuffer()
        const { width: cutWidth, height: cutHeight } = await sharp(cut).metadata()
        for (const longest of [160, ...(skyIcons.has(slug) ? [320] : []), ...(menuOnlyIcons.has(slug) ? [] : [640])]) {
            const pad = longest / 80
            const scale = (longest - 2 * pad) / Math.max(cutWidth, cutHeight)
            const width = Math.round(cutWidth * scale)
            const height = Math.round(cutHeight * scale)
            await sharp(cut)
                .resize(width, height, { kernel: "lanczos3" })
                .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp(webp(90))
                .toFile(art(`icons/${slug}-${longest}.webp`))
        }
        console.log(`wrote icons/${slug} (${cutWidth}x${cutHeight})`)
    }
}

// The icons that move part by part, listed with their motions in scripts/icon-parts/parts.json. Each part is cut at the scale of the
// 640 icon and to its own box, and src/lib/icon-parts.json says where it sits as shares of the icon's square. Under them lie the
// outline, which is what the whole icon has around the stacked parts, and the icon's shadow, baked so nothing blurs as it moves
const shadowSize = 320
const outlineReach = 12
const shadowRoom = 0.25

async function writeParts() {
    const parts = JSON.parse(await readFile(new URL("./icon-parts/parts.json", import.meta.url), "utf8"))
    const out = {}
    await rm(art("icons/parts"), { recursive: true, force: true })
    const folders = await readdir(family)
    for (const [slug, slices] of Object.entries(parts)) {
        const folder = folders.find((name) => name.endsWith(`-${slug}`))
        const source = `${family}${folder}/`
        const whole = `${source}${folder}.png`
        await mkdir(art(`icons/parts/${slug}`), { recursive: true })
        const { info: trim } = await sharp(whole).trim({ threshold: 0 }).toBuffer({ resolveWithObject: true })
        const box = { left: -trim.trimOffsetLeft, top: -trim.trimOffsetTop, width: trim.width, height: trim.height }
        const pad = 8
        const scale = (640 - 2 * pad) / Math.max(box.width, box.height)
        const shown = { width: Math.round(box.width * scale), height: Math.round(box.height * scale) }
        const frame = { left: (640 - shown.width) / 2, top: (640 - shown.height) / 2 }
        const share = (value) => Math.round((value / 640) * 100000) / 100000

        // What the whole icon has around the stacked parts, as a layer under them
        const stacked = await sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
            .composite(slices.map((slice, index) => ({ input: `${source}${index + 1}-${slice.name}.png` })))
            .raw()
            .toBuffer()
        const finished = await pixels(whole)
        const outline = Buffer.alloc(finished.length)
        for (let i = 0; i < finished.length; i += 4) {
            const over = stacked[i + 3] / 255
            const all = finished[i + 3] / 255
            const under = over >= 1 ? 0 : Math.max(0, (all - over) / (1 - over))
            if (under < 1 / 255) continue
            for (let c = 0; c < 3; c++) {
                const value = (finished[i + c] * all - stacked[i + c] * over) / (under * (1 - over))
                outline[i + c] = Math.round(Math.min(255, Math.max(0, value)))
            }
            outline[i + 3] = Math.round(under * 255)
        }

        // A moving part takes the outline around it along, so none is left behind where it was. What no moving part claims stays still
        const stillOutline = Buffer.from(outline)
        const inputs = new Map()
        for (const [index, slice] of slices.entries()) {
            const file = `${source}${index + 1}-${slice.name}.png`
            if (!slice.move) {
                inputs.set(slice.name, file)
                continue
            }
            const shape = await sharp(file).ensureAlpha().extractChannel(3).raw().toBuffer()
            const near = await sharp(shape, { raw: { width: canvas, height: canvas, channels: 1 } }).blur(outlineReach).toColourspace("b-w").raw().toBuffer()
            const own = Buffer.alloc(outline.length)
            for (let i = 0; i < near.length; i++) {
                const at = i * 4
                if (near[i] < 6 || stillOutline[at + 3] === 0) continue
                outline.copy(own, at, at, at + 4)
                stillOutline[at + 3] = 0
            }
            inputs.set(slice.name, await sharp(own, { raw: rawCanvas }).composite([{ input: file }]).png().toBuffer())
        }
        inputs.set("outline", await sharp(stillOutline, { raw: rawCanvas }).png().toBuffer())

        const pieces = []
        const entries = [{ name: "outline" }, ...slices]
        for (const entry of entries) {
            const sized = await sharp(inputs.get(entry.name)).extract(box).resize(shown.width, shown.height, { kernel: "lanczos3" }).png().toBuffer()
            const { data, info } = await sharp(sized).trim({ threshold: 0 }).toBuffer({ resolveWithObject: true })
            const left = -(info.trimOffsetLeft ?? 0)
            const top = -(info.trimOffsetTop ?? 0)
            await sharp(data).webp(webp(90)).toFile(art(`icons/parts/${slug}/${entry.name}.webp`))
            const piece = { src: `/art/icons/parts/${slug}/${entry.name}.webp`, left: share(frame.left + left), top: share(frame.top + top), width: share(info.width), height: share(info.height) }
            if (entry.move) {
                const around = entry.move.around ?? [box.left + box.width / 2, box.top + box.height / 2]
                piece.move = {
                    kind: entry.move.kind ?? "sway",
                    seconds: entry.move.seconds,
                    x: share((entry.move.x ?? 0) * scale),
                    y: share((entry.move.y ?? 0) * scale),
                    turn: entry.move.turn ?? 0,
                    aroundX: share(frame.left + (around[0] - box.left) * scale),
                    aroundY: share(frame.top + (around[1] - box.top) * scale),
                }
            }
            pieces.push(piece)
        }

        // The shadow the whole icon casts on the page: its shape, dropped a little and softened once here
        const inner = Math.round(shadowSize / (1 + 2 * shadowRoom))
        const room = Math.round((shadowSize - inner) / 2)
        const fit = (inner * shown.width) / 640
        const fitTall = (inner * shown.height) / 640
        const shape = await sharp(whole).extract(box).resize(Math.round(fit), Math.round(fitTall)).ensureAlpha().extractChannel(3).toBuffer()
        const offset = Math.round(inner * 0.08)
        const black = await sharp({ create: { width: shadowSize, height: shadowSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
            .composite([{ input: await sharp({ create: { width: Math.round(fit), height: Math.round(fitTall), channels: 3, background: { r: 0, g: 0, b: 0 } } }).joinChannel(shape).png().toBuffer(), left: room + Math.round((inner - fit) / 2), top: room + Math.round((inner - fitTall) / 2) + offset }])
            .png()
            .toBuffer()
        const { data: shadowData, info: shadowInfo } = await sharp(black).blur(inner * 0.055).raw().toBuffer({ resolveWithObject: true })
        for (let i = 3; i < shadowData.length; i += 4) shadowData[i] = Math.round(shadowData[i] * 0.5)
        await sharp(shadowData, { raw: shadowInfo }).webp({ quality: 70, alphaQuality: 70, effort: 6 }).toFile(art(`icons/parts/${slug}/shadow.webp`))

        out[slug] = { shadow: `/art/icons/parts/${slug}/shadow.webp`, shadowRoom, pieces }
        console.log(`wrote icons/parts/${slug} (${pieces.length} parts)`)
    }
    await writeFile(new URL("../src/lib/icon-parts.json", import.meta.url), `${JSON.stringify(out)}\n`)
}

// The living face: the PSD's parts of the glass, stacked as the PSD stacks them and cut to their boxes, so the shader can move
// each and still give the painted glass at rest. The black hole's parts are grouped by what moves together. src/lib/art.ts
// mirrors these boxes
const screenBox = { left: 537, top: 800, width: 992, height: 815 }
const holeBox = { left: 595, top: 1369, width: 865, height: 192 }
const faceParts = [
    { name: "far", layers: ["atmosphere"], box: screenBox },
    { name: "lens", layers: ["hole-violet-far", "hole-void", "hole-ring"], box: holeBox },
    { name: "flow", layers: ["hole-floor", "hole-disk", "hole-teal"], box: holeBox },
    { name: "violet", layers: ["hole-violet-near", "hole-accents"], box: holeBox },
    { name: "eyes", layers: ["eyes"], box: { left: 613, top: 894, width: 802, height: 337 } },
    { name: "brows", layers: ["brow-cyan", "brow-violet"], box: { left: 640, top: 860, width: 750, height: 116 } },
    // With room around the strokes, which is where their light falls
    { name: "waves", layers: ["waves"], box: { left: 830, top: 1040, width: 366, height: 316 } },
    { name: "crescents", layers: ["crescents"], box: { left: 600, top: 1187, width: 848, height: 168 } },
    { name: "sheen", layers: ["glass-reflections"], box: screenBox },
]
// The soft light of the galaxy, which turns slowly around the middle of the glass, so it is cut to a square around that
// middle and softened, because the copy drifts over the painted light as mist
const mistBox = { left: 537, top: 682, width: 992, height: 992 }
const mistParts = ["galaxy-cyan", "galaxy-well", "galaxy-violet"].map(layer)

async function writeFace() {
    await mkdir(art("face"), { recursive: true })
    for (const { name, layers, box } of faceParts) {
        const cut = await sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
            .composite(layers.map((input) => ({ input: layer(input) })))
            .png()
            .toBuffer()
        await sharp(cut).extract(box).webp(webp(92)).toFile(art(`face/${name}.webp`))
        console.log(`wrote face/${name}.webp (${box.width}x${box.height})`)
    }
    // The soft light of the waves, baked once at a quarter of its box. It stays close to the strokes, a glow on each line, never one
    // haze between them that reads as a lit ball
    const wavesBox = { left: 830, top: 1040, width: 366, height: 316 }
    const shape = await sharp(layer("waves")).ensureAlpha().extractChannel(3).raw().toBuffer()
    const soft = await sharp(shape, { raw: { width: canvas, height: canvas, channels: 1 } }).blur(9).toColourspace("b-w").raw().toBuffer()
    const glow = Buffer.alloc(canvas * canvas * 4)
    for (let i = 0; i < soft.length; i++) {
        glow.fill(255, i * 4, i * 4 + 3)
        glow[i * 4 + 3] = soft[i]
    }
    await sharp(glow, { raw: rawCanvas }).extract(wavesBox).resize(Math.round(wavesBox.width / 4), Math.round(wavesBox.height / 4)).webp({ quality: 90, alphaQuality: 100, effort: 6 }).toFile(art("face/waves-light.webp"))
    console.log("wrote face/waves-light.webp")
    const light = await sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite(mistParts.map((input) => ({ input })))
        .png()
        .toBuffer()
    await sharp(light)
        .extract(mistBox)
        .blur(3)
        .resize(mistBox.width / 2, mistBox.height / 2, { kernel: "lanczos3" })
        .webp({ quality: 88, alphaQuality: 90, effort: 6, smartSubsample: true })
        .toFile(art("face/mist.webp"))
    console.log(`wrote face/mist.webp (${mistBox.width / 2}x${mistBox.height / 2})`)
    // The glass: what the atmosphere covers and the cap and the bow leave open. The picture ends here
    const [sky, cap, bow] = await Promise.all(["atmosphere", "cap", "bow"].map((name) => pixels(layer(name))))
    const mask = Buffer.alloc(screenBox.width * screenBox.height * 4)
    for (let y = 0; y < screenBox.height; y++) {
        for (let x = 0; x < screenBox.width; x++) {
            const i = (y * screenBox.width + x) * 4
            const j = ((y + screenBox.top) * canvas + x + screenBox.left) * 4 + 3
            mask.fill(255, i, i + 3)
            mask[i + 3] = Math.round((sky[j] * (255 - cap[j]) * (255 - bow[j])) / (255 * 255))
        }
    }
    await sharp(mask, { raw: { width: screenBox.width, height: screenBox.height, channels: 4 } })
        .webp({ quality: 90, alphaQuality: 100, effort: 6 })
        .toFile(art("face/glass.webp"))
    console.log(`wrote face/glass.webp (${screenBox.width}x${screenBox.height})`)
}

// The conductor's inner universe carried into the space below the hero, so the page has depth: the two crescents and
// the soft light of the galaxy drift far behind the sections, and the brows, its near clouds, pass in front of the
// margins. Each is cut from its part at the alpha box measured on the 2048 canvas, padded, and softened once here as
// the eye sees things out of focus, so nothing is blurred by the page while it moves. The light is faint on the
// face, so it is lifted to carry alone on the page. src/components/sections/Depth.astro names them
const depthParts = [
    { name: "crescent-cyan", layer: "crescents", box: { left: 609, top: 1195, width: 150, height: 152 }, longest: 288, blur: 1.1 },
    { name: "crescent-violet", layer: "crescents", box: { left: 1289, top: 1195, width: 150, height: 152 }, longest: 288, blur: 1.1 },
    { name: "cloud-cyan", layer: "brow-cyan", box: { left: 655, top: 896, width: 213, height: 65 }, longest: 640, blur: 7 },
    { name: "cloud-violet", layer: "brow-violet", box: { left: 1162, top: 875, width: 214, height: 65 }, longest: 640, blur: 7 },
]

async function writeDepth() {
    await mkdir(art("depth"), { recursive: true })
    for (const part of depthParts) {
        const scale = part.longest / Math.max(part.box.width, part.box.height)
        const width = Math.round(part.box.width * scale)
        const height = Math.round(part.box.height * scale)
        // Room for the softened edge, which would otherwise be cut flat
        const pad = Math.ceil(part.blur * 3) + 4
        const { data, info } = await sharp(layer(part.layer))
            .extract(part.box)
            .resize(width, height, { kernel: "lanczos3" })
            .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .blur(part.blur)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true })
        if (part.lift) for (let i = 3; i < data.length; i += 4) data[i] = Math.min(255, Math.round(data[i] * part.lift))
        await sharp(data, { raw: info }).webp(webp(86)).toFile(art(`depth/${part.name}.webp`))
        console.log(`wrote depth/${part.name}.webp (${width + 2 * pad}x${height + 2 * pad})`)
    }
}

// The gold light around the maker's badge, baked so the browser draws no filter for it as it scrolls in:
// the badge's own shape blurred as the browser drew drop-shadow(0 0 10px rgb(236 196 110 / 0.28)), which
// measured against its rendering is a deviation of the whole 10 px, with the tail kept to 3 deviations.
// Drawn at 4 pixels per CSS pixel on the badge's 44 px box with 32 px of room on each side, where the light
// has gone. src/components/sections/Maker.astro draws the badge from the same paths on its 40-unit box and
// places this picture with that room
const badgePaths = [
    "M0-17 3.9-5.4 0 0ZM16.2-5.3 6.3 2 0 0ZM10 13.8 0 6.6 0 0ZM-10 13.8-6.3 2 0 0ZM-16.2-5.3-3.9-5.4 0 0Z",
    "M0-17-3.9-5.4 0 0ZM16.2-5.3 3.9-5.4 0 0ZM10 13.8 6.3 2 0 0ZM-10 13.8 0 6.6 0 0ZM-16.2-5.3-6.3 2 0 0Z",
    "M0-4.6 3.4 0 0 4.6-3.4 0Z",
]

async function writeBadgeGlow() {
    const scale = 4
    const side = (44 + 2 * 32) * scale
    const unit = (44 / 40) * scale
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><g transform="translate(${side / 2} ${side / 2}) scale(${unit})" fill="#fff">${badgePaths.map((d) => `<path d="${d}"/>`).join("")}</g></svg>`
    const shape = await sharp(Buffer.from(svg)).ensureAlpha().extractChannel(3).raw().toBuffer()
    const light = await sharp(shape, { raw: { width: side, height: side, channels: 1 } })
        .blur({ sigma: 10 * scale, minAmplitude: 0.011 })
        .toColourspace("b-w")
        .raw()
        .toBuffer()
    const glow = Buffer.alloc(side * side * 4)
    for (let i = 0; i < side * side; i++) {
        glow[i * 4] = 236
        glow[i * 4 + 1] = 196
        glow[i * 4 + 2] = 110
        glow[i * 4 + 3] = Math.round(light[i] * 0.28)
    }
    await sharp(glow, { raw: { width: side, height: side, channels: 4 } })
        .webp({ lossless: true, effort: 6 })
        .toFile(art("badge-glow.webp"))
    console.log(`wrote badge-glow.webp (${side}x${side})`)
}

// The hero draws the conductor between about 390 and 780 device pixels wide across the target screens, so the
// mascot also comes at 876 and no screen downloads the largest for nothing. src/lib/art.ts lists the same widths
const mascotWidths = [1168, 876, 584]

// The share picture every page's link preview shows, from the social preview at the size link previews ask for, and the favicon at
// the sizes browsers, phones and search results ask for, from the one drawing in public/favicon.svg
const socialPreview = `${originals}fluxerly-github-social.png`

async function writeSiteIcons() {
    await sharp(socialPreview).resize(1200, 630, { fit: "cover", position: "centre" }).flatten().jpeg({ quality: 90, mozjpeg: true }).toFile(fileURLToPath(new URL("../public/og-image.jpg", import.meta.url)))
    const drawing = await readFile(new URL("../public/favicon.svg", import.meta.url))
    const write = (size, name) => sharp(drawing, { density: 72 * (size / 32) }).resize(size, size).png({ compressionLevel: 9 }).toFile(fileURLToPath(new URL(`../public/${name}`, import.meta.url)))
    await write(48, "favicon-48.png")
    // iOS turns a transparent icon's background black, so this one size gets the night behind it
    await sharp(drawing, { density: 72 * (180 / 32) }).resize(180, 180).flatten({ background: "#0a0d33" }).png({ compressionLevel: 9 }).toFile(fileURLToPath(new URL("../public/apple-touch-icon.png", import.meta.url)))
    await write(192, "icon-192.png")
    await write(512, "icon-512.png")
    console.log("wrote og-image.jpg and the favicon sizes")
}

// The conductor at the end of the page, with the cloth of its cap apart so the updraft can fill it, the fan and the fold over a
// cap that stays on its head. Together they are the mascot again
async function writeEnding() {
    await writeSizes(await png(await stacked(["cap"])), "ending-body", 92, [584])
    // Under the moving parts, which come from the face's own pictures: the conductor with those parts taken out
    await writeSizes(await png(await stacked(["cap", "black-hole", "eyes", "brow-cyan", "brow-violet", "waves", "crescents"])), "ending-base", 92, [584])
    for (const part of ["fan", "fold", "seat"]) await writeSizes(await sharp(layer(`cap-${part}`)).png().toBuffer(), `ending-${part}`, 92, [584])
}

// The hero conductor's bow tie, which wiggles from its knot: the bow itself, and what lies under it, the frame's rim and nothing
// below, cut to the bow's own shape. The page hides the painted bow with the bow's shape and lays these over it, so the live bow
// can turn without the painted one showing behind it. At the mascot's own sizes, so it is exactly as sharp
async function writeBow() {
    const bow = await pixels(layer("bow"))
    const under = await stacked(["bow"])
    for (let i = 3; i < under.length; i += 4) under[i] = Math.round((under[i] * bow[i]) / 255)
    await writeSizes(await sharp(layer("bow")).png().toBuffer(), "bow", 92, mascotWidths)
    await writeSizes(await png(under), "bow-under", 92, mascotWidths)
}

// The conductor at a small size, written into the page itself, so it holds the conductor's place from the first frame and the whole
// picture resolves out of it without a jump. Large enough to keep the frame's rim and glow, which a tinier one blurred away, and with
// its edges at full alpha quality, since the night shows through them
async function writeMascotPreview() {
    const picture = await sharp(fileURLToPath(new URL("../public/art/mascot-1168.webp", import.meta.url))).resize({ width: 240 }).webp({ quality: 60, alphaQuality: 100, effort: 6, smartSubsample: true }).toBuffer()
    await writeFile(fileURLToPath(new URL("../src/lib/mascot-preview.json", import.meta.url)), `${JSON.stringify({ src: `data:image/webp;base64,${picture.toString("base64")}` })}\n`)
    console.log(`wrote the conductor's preview, ${picture.length} bytes`)
}

const steps = {
    mascot: () => writeSizes(finished, "mascot", 92, mascotWidths),
    preview: writeMascotPreview,
    glow: async () => writeSizes(await withHalo(await waves()), "waves-glow", 92),
    face: writeFace,
    parts: writeParts,
    ending: writeEnding,
    bow: writeBow,
    site: writeSiteIcons,
    icons: writeIcons,
    depth: writeDepth,
    badge: writeBadgeGlow,
}
const only = process.argv.slice(2)
for (const [name, step] of Object.entries(steps)) {
    if (only.length === 0 || only.includes(name)) await step()
}
