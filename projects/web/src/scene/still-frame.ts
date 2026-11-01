// The Still sky: one frame of the hero scene kept as a plain 2D canvas, so Still holds no WebGL
// once it is painted. It sits under the live canvas, which lets the modes hand over without a flash.

const maxPixelRatio = 1.5

export function scenePixelRatio() {
    return Math.min(window.devicePixelRatio || 1, maxPixelRatio)
}

// Size and pixel ratio a frame is painted for. A frame painted for anything else is stale
export function frameKey(width: number, height: number) {
    return `${Math.round(width)}x${Math.round(height)}@${scenePixelRatio()}`
}

export function currentFrameKey(hero: HTMLElement) {
    const box = hero.getBoundingClientRect()
    return frameKey(box.width, box.height)
}

export function stillFrame(hero: HTMLElement): HTMLCanvasElement | null {
    const slot = hero.querySelector<HTMLElement>("[data-scene-slot]")
    if (!slot) return null
    let frame = slot.querySelector<HTMLCanvasElement>("canvas[data-scene-frame]")
    if (!frame) {
        frame = document.createElement("canvas")
        frame.dataset.sceneFrame = ""
        // First child, so a live canvas always paints over it
        slot.prepend(frame)
    }
    return frame
}

export function showFrame(frame: HTMLCanvasElement, instant: boolean) {
    // An empty inline transition hands the fade back to the stylesheet
    frame.style.transition = instant ? "none" : ""
    frame.style.opacity = "1"
}

export function hideFrame(frame: HTMLCanvasElement) {
    frame.style.transition = "none"
    frame.style.opacity = "0"
}
