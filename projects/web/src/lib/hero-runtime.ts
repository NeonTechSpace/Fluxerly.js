// Runs on every page load in both states. Keep it small: Three.js arrives only through the
// dynamic imports below. Still loads the frame chunk once to paint its frozen sky and then
// holds no WebGL. GSAP comes only with the live scene.

import { getExperience, subscribeExperience, type Experience } from "./experience"
import { skyIconsKey, specs } from "../scene/companion-specs"
import { findHeroParts, measureHero } from "../scene/layout"
import type { HeroFrame } from "../scene/hero-frame"
import type { HeroScene } from "../scene/hero-scene"

// A control counts as near the water when the gap to the waterline is under this share of the hero height
const nearWater = 0.09
// How long the scene waits for the sky's icons on a slow network, and the words for them, which is far less
const iconLimit = 1000
// How long the scene's code waits for the conductor's picture on a slow network before it loads anyway
const pictureLimit = 4000

export function startHero(hero: HTMLElement) {
    const iconsHere = placeSkyIcons(hero)
    watchControlReflections(hero)
    // The scene's start holds the page up for a moment, so the page gets its first frame with the icons in it first
    iconsHere.then(afterPaint).then(() => driveScene(hero))
}

// The icons in the sky take the places the scene will draw them in, read from the same numbers, so nothing appears or moves when it takes over
function placeSkyIcons(hero: HTMLElement): Promise<unknown> {
    const box = hero.querySelector<HTMLElement>(".sky-icons")
    const icons = [...hero.querySelectorAll<HTMLImageElement>("[data-sky-icon]")]
    const parts = findHeroParts(hero)
    const lift = () => delete document.documentElement.dataset.iconsWait
    if (!box || !parts) {
        lift()
        return Promise.resolve()
    }
    const place = () => {
        const layout = measureHero(hero, parts)
        const zoom = hero.offsetWidth > 0 ? layout.width / hero.offsetWidth : 1
        icons.forEach((icon, index) => {
            const spec = specs[index]!
            const shown = !layout.stacked && (spec.fits?.(layout) ?? true)
            icon.hidden = !shown
            if (!shown) return
            const [x, y] = spec.place(layout)
            icon.style.height = `${(spec.size * layout.height) / zoom}px`
            icon.style.transform = `translate(${x / zoom}px, ${y / zoom}px) translate(-50%, -50%) rotate(${-spec.tilt[0]}deg)`
        })
    }
    new ResizeObserver(place).observe(hero)
    document.fonts?.ready.then(place)
    place()
    // Not longer than a slow network's patience: the scene doesn't wait for a picture that never comes
    const mascot = hero.querySelector<HTMLImageElement>("[data-mascot]")
    const pictures = [...icons.filter((icon) => !icon.hidden), ...(mascot ? [mascot] : [])]
    // Already here, as on a return to a phone's page, they are simply there. Only pictures that had to arrive fade in. Where the sky has icons the head decides this, see Hero.astro
    if (pictures.every((picture) => picture.complete && picture.naturalWidth > 0)) document.documentElement.dataset.artHere = ""
    const decoded = Promise.all(pictures.map((picture) => picture.decode().catch(() => {})))
    decoded.then(() => {
        const shown = icons.filter((icon) => !icon.hidden)
        if (!shown.length || !shown.every((icon) => icon.complete && icon.naturalWidth > 0)) return
        try {
            localStorage.setItem(skyIconsKey, "1")
        } catch {
            // Storage is blocked, so the next visit counts as a first one
        }
    })
    return Promise.race([decoded, new Promise((done) => window.setTimeout(done, iconLimit))]).then(lift)
}

const afterPaint = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))

function watchControlReflections(hero: HTMLElement) {
    const wrap = hero.querySelector<HTMLElement>("[data-controls]")
    const horizon = hero.querySelector<HTMLElement>("[data-horizon]")
    if (!wrap || !horizon) return
    const update = () => {
        const gap = horizon.getBoundingClientRect().top - wrap.getBoundingClientRect().bottom
        const near = gap > 0 && gap <= hero.clientHeight * nearWater
        wrap.dataset.reflect = near ? "on" : "off"
        // The mirrored row starts as far below the waterline as the real row ends above it
        wrap.style.setProperty("--reflect-gap", `${(gap * 2).toFixed(1)}px`)
    }
    new ResizeObserver(update).observe(hero)
    document.fonts?.ready.then(update)
    update()
}

// The conductor's picture alone, decoded, or the wait given up on a slow network. The scene's code, 640 KB, waits for it, so the picture is not slowed by that download
// and the conductor stands before the live sky takes over from it
function pictureReady(hero: HTMLElement): Promise<void> {
    const mascot = hero.querySelector<HTMLImageElement>("[data-mascot]")
    if (!mascot || (mascot.complete && mascot.naturalWidth > 0)) return Promise.resolve()
    return Promise.race([mascot.decode().catch(() => {}), new Promise<void>((resolve) => window.setTimeout(resolve, pictureLimit))])
}

function driveScene(hero: HTMLElement) {
    let scene: HeroScene | null = null
    let still: HeroFrame | null = null
    let sceneModule: Promise<typeof import("../scene/hero-scene")> | null = null
    let frameModule: Promise<typeof import("../scene/hero-frame")> | null = null
    let request = 0

    const apply = async (mode: Experience) => {
        const ticket = ++request
        hero.dataset.experience = mode
        if (mode === "still") {
            // A live scene leaves its rest frame behind as it fades out
            scene?.dispose()
            scene = null
            if (still) return
            await pictureReady(hero)
            if (ticket !== request) return
            frameModule ??= import("../scene/hero-frame")
            try {
                const module = await frameModule
                if (ticket !== request) return
                still = module.freezeHeroScene(hero)
            } catch {
                // Offline or blocked chunk: stay on the CSS sky and allow a later retry
                frameModule = null
            }
            return
        }
        // The frame stays under the live canvas, which fades in over it
        still?.dispose()
        still = null
        if (scene) return
        await pictureReady(hero)
        if (ticket !== request) return
        sceneModule ??= import("../scene/hero-scene")
        try {
            const module = await sceneModule
            if (ticket !== request) return
            scene = module.createHeroScene(hero)
        } catch {
            sceneModule = null
        }
    }

    apply(getExperience())
    subscribeExperience(apply)
}
