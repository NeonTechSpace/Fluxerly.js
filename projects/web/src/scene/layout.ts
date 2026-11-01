// Reads the hero composition from the DOM. CSS owns the layout, the scene follows it.

export interface HeroParts {
    horizon: HTMLElement
    conductorSlot: HTMLElement
    conductorReflection: HTMLElement
    // The words and controls the sky must keep clear of
    text: HTMLElement[]
}

export interface Box {
    left: number
    top: number
    right: number
    bottom: number
}

export interface HeroLayout {
    width: number
    height: number
    // Distances in CSS pixels from the top left of the hero box
    horizon: number
    conductor: { left: number, top: number, width: number, height: number }
    // Screen line of the water right under the conductor. Its reflection mirrors around it
    waterLine: number
    // Where the words and controls actually end, not their full width blocks
    text: Box
    // The wordmark alone, which the icons in the sky above the words must not touch on a short screen
    title: Box
    // The narrow layout stacks the conductor over the words, so nothing may float beside them
    stacked: boolean
}

export const stackedQuery = "(max-width: 899px), (max-height: 480px), (max-aspect-ratio: 4/5)"

export function findHeroParts(hero: HTMLElement): HeroParts | null {
    const horizon = hero.querySelector<HTMLElement>("[data-horizon]")
    const conductorSlot = hero.querySelector<HTMLElement>("[data-conductor-slot]")
    const conductorReflection = hero.querySelector<HTMLElement>("[data-conductor-reflection]")
    if (!horizon || !conductorSlot || !conductorReflection) return null
    const text = [...hero.querySelectorAll<HTMLElement>("[data-hero-text], [data-controls] > :first-child, [data-slab]")]
    return { horizon, conductorSlot, conductorReflection, text }
}

// The ink of an element: the union of its line boxes and child boxes
function inkBox(element: HTMLElement) {
    const range = document.createRange()
    range.selectNodeContents(element)
    const box = range.getBoundingClientRect()
    return box.width > 0 ? box : element.getBoundingClientRect()
}

export function measureHero(hero: HTMLElement, parts: HeroParts): HeroLayout {
    const box = hero.getBoundingClientRect()
    const slot = parts.conductorSlot.getBoundingClientRect()
    const reflection = parts.conductorReflection.getBoundingClientRect()
    const horizon = parts.horizon.getBoundingClientRect().top - box.top
    const conductor = {
        left: slot.left - box.left,
        top: slot.top - box.top,
        width: slot.width,
        height: slot.height,
    }
    const bottom = conductor.top + conductor.height

    // The still reflection is placed by CSS at bottom + 2 * gap. Reuse that gap so both skies agree
    let gap = (reflection.top - box.top - bottom) / 2
    if (!(reflection.height > 0) || !(gap > 0)) gap = Math.max(box.height * 0.024, horizon + box.height * 0.03 - bottom)

    const text: Box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
    for (const element of parts.text) {
        const ink = inkBox(element)
        if (!(ink.width > 0)) continue
        text.left = Math.min(text.left, ink.left - box.left)
        text.top = Math.min(text.top, ink.top - box.top)
        text.right = Math.max(text.right, ink.right - box.left)
        text.bottom = Math.max(text.bottom, ink.bottom - box.top)
    }
    if (!(text.right > text.left)) Object.assign(text, { left: 0, top: horizon, right: 0, bottom: horizon })

    const titleInk = hero.querySelector<HTMLElement>(".wordmark")?.getBoundingClientRect()
    const title: Box = titleInk ? { left: titleInk.left - box.left, top: titleInk.top - box.top, right: titleInk.right - box.left, bottom: titleInk.bottom - box.top } : text

    return {
        width: box.width,
        height: box.height,
        horizon,
        conductor,
        waterLine: Math.max(bottom + gap, horizon + 4),
        text,
        title,
        stacked: window.matchMedia(stackedQuery).matches,
    }
}
