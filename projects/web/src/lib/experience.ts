// Experience: Immersive, the world alive, or Still, the same world with time stopped. Still is this
// site's reduce motion switch. The current state lives on <html data-experience> so every bundle on
// the page shares it, and it still works when storage is blocked.
//
// A saved press of the header's switch decides, in either direction. With none, the system reduce motion setting does.
// <html data-still> carries the result for the stylesheets, set before the first paint, see PageTransitions.astro

export type Experience = "immersive" | "still"

export const experienceKey = "fluxerly.experience.v1"
export const experiences: readonly Experience[] = ["immersive", "still"]

const changeEvent = "fluxerly:experience"
const reducedMotionQuery = "(prefers-reduced-motion: reduce)"

export function isExperience(value: unknown): value is Experience {
    return typeof value === "string" && (experiences as readonly string[]).includes(value)
}

export function prefersReducedMotion(): boolean {
    return window.matchMedia(reducedMotionQuery).matches
}

function readStored(): Experience | null {
    try {
        const value = window.localStorage.getItem(experienceKey)
        if (isExperience(value)) return value
        // A value saved by an earlier build with a third state means the world alive
        if (value === "ambient") return "immersive"
        return null
    } catch {
        return null
    }
}

function defaultExperience(): Experience {
    return prefersReducedMotion() ? "still" : "immersive"
}

export function getExperience(): Experience {
    const held = document.documentElement.dataset.experience
    if (isExperience(held)) return held
    return readStored() ?? defaultExperience()
}

// Whether the visitor has chosen, here or on an earlier visit
export function hasChosenExperience(): boolean {
    return document.documentElement.dataset.experienceChosen !== undefined || readStored() !== null
}

function announce(mode: Experience) {
    document.documentElement.dataset.experience = mode
    document.documentElement.toggleAttribute("data-still", mode === "still")
    window.dispatchEvent(new CustomEvent<Experience>(changeEvent, { detail: mode }))
}

// Asked of what the page shows, since with nothing held getExperience already reads the new state
function follow(mode: Experience) {
    if ((mode === "still") !== document.documentElement.hasAttribute("data-still")) announce(mode)
}

export function setExperience(mode: Experience) {
    document.documentElement.dataset.experienceChosen = "true"
    try {
        window.localStorage.setItem(experienceKey, mode)
    } catch {
        // Storage is blocked, the state stays in memory for this page
    }
    announce(mode)
}

// Calls back with the new state whenever it changes, from this page, another tab,
// or a reduced motion change while nothing is chosen.
export function subscribeExperience(listener: (mode: Experience) => void): () => void {
    const onChange = (event: Event) => {
        const mode = (event as CustomEvent<Experience>).detail
        if (isExperience(mode)) listener(mode)
    }
    const onStorage = (event: StorageEvent) => {
        if (event.key !== experienceKey) return
        follow(isExperience(event.newValue) ? event.newValue : defaultExperience())
    }
    const motionQuery = window.matchMedia(reducedMotionQuery)
    const onMotionChange = () => {
        if (!hasChosenExperience()) follow(defaultExperience())
    }
    window.addEventListener(changeEvent, onChange)
    window.addEventListener("storage", onStorage)
    motionQuery.addEventListener("change", onMotionChange)
    // A change while this page's scripts were on their way had nobody listening, so the page may show an older state than the one read now
    follow(getExperience())
    return () => {
        window.removeEventListener(changeEvent, onChange)
        window.removeEventListener("storage", onStorage)
        motionQuery.removeEventListener("change", onMotionChange)
    }
}
