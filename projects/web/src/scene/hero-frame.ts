// Still mode: renders the hero world once at rest, keeps that frame as a 2D image and releases
// WebGL right away. Nothing keeps running: no ticker, no WebGL context. A resize paints a new frame.

import { createWorld, restPose } from "./world"
import { currentFrameKey, hideFrame, showFrame, stillFrame } from "./still-frame"

export interface HeroFrame {
    dispose(): void
}

// Wait for a resize to settle before painting again
const settleDelay = 250

export function freezeHeroScene(hero: HTMLElement): HeroFrame | null {
    const frame = stillFrame(hero)
    if (!frame) return null

    let disposed = false
    let painting = false
    let again = false
    let timer = 0
    let lastKey = currentFrameKey(hero)

    const reveal = () => {
        showFrame(frame, false)
        hero.dataset.scene = "frame"
    }

    const paint = async () => {
        if (disposed) return
        if (painting) {
            again = true
            return
        }
        if (frame.dataset.key === currentFrameKey(hero)) {
            reveal()
            return
        }
        const world = createWorld(hero)
        if (!world) {
            // No WebGL: the CSS sky is the frame
            return
        }
        painting = true
        try {
            await world.load()
            if (!disposed && world.relayout()) {
                world.render(restPose)
                world.capture(frame)
                reveal()
            }
        } catch {
            // The CSS sky stays
        } finally {
            world.release()
            painting = false
        }
        if (again) {
            again = false
            paint()
        }
    }

    const observer = new ResizeObserver(() => {
        const key = currentFrameKey(hero)
        if (key === lastKey) return
        lastKey = key
        // A stretched frame would misplace the reflection, so the CSS sky covers until the new one is ready
        if (frame.dataset.key !== key) {
            hideFrame(frame)
            if (hero.dataset.scene === "frame") delete hero.dataset.scene
        }
        window.clearTimeout(timer)
        timer = window.setTimeout(paint, settleDelay)
    })
    observer.observe(hero)
    paint()

    return {
        dispose() {
            disposed = true
            window.clearTimeout(timer)
            observer.disconnect()
        },
    }
}
