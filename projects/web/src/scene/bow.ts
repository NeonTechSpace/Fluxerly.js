// The live conductor's bow tie, which wiggles from its knot as src/scene/face-life.ts decides. Nothing but the sky lies under most
// of the painted bow, so a turned copy over it would show the painted one behind. Instead a copy of the painted conductor drawn
// without the bow's own shape, with what lay under the bow (the frame's rim) back in its place, stands over the painted one, and the
// live bow goes over it. At rest they are the painted conductor again, so it takes over without being seen. The copy is drawn whole
// before it is shown: A CSS mask on the painted conductor hid the whole head for a moment while the browser readied the mask's
// picture. The painted conductor stays on the page, hidden, and still picks its file for the window's size, so when a window that
// grows gives it a larger file the copy is drawn again from that one

import { bowFile, bowSrcset, bowUnderFile, mascotWidthOf } from "../lib/art"
import type { FacePart } from "./face-life"

export interface Bow {
    // Loads the pictures and puts them on the conductor once they are decoded
    load(): Promise<void>
    render(bow: FacePart): void
    release(): void
}

// The knot, as shares of the trimmed mascot
const knot = "49.23% 94.51%"

export function createBow(conductor: HTMLElement, mascot: HTMLImageElement): Bow {
    const picture = (srcset: string) => {
        const image = new Image()
        image.alt = ""
        image.decoding = "async"
        // The same size as the conductor's own picture, so the bow is exactly as sharp
        image.sizes = mascot.sizes
        image.srcset = srcset
        Object.assign(image.style, { position: "absolute", inset: "0", width: "100%", height: "100%", maxWidth: "none", pointerEvents: "none" })
        return image
    }
    const bow = picture(bowSrcset)
    bow.style.transformOrigin = knot
    bow.style.willChange = "transform"
    bow.dataset.bow = ""
    const body = document.createElement("canvas")
    body.dataset.bowBody = ""
    body.setAttribute("aria-hidden", "true")
    Object.assign(body.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" })
    let released = false
    // The painted conductor's file the copy is drawn from, and the latest drawing asked for, so an older one that finishes late is dropped
    let drawn = ""
    let asked = 0

    // Decoded whole. A window that grows or turns while a picture loads can pick a larger file, which turns its decode down, so it waits
    // for that file instead, and only a file that fails fails
    const whole = (image: HTMLImageElement): Promise<void> =>
        image.decode().catch((reason: unknown) => {
            if (image.complete && image.naturalWidth > 0) return
            if (image.complete) throw reason
            return new Promise<void>((done, fail) => {
                const settled = new AbortController()
                const { signal } = settled
                image.addEventListener("load", () => (settled.abort(), done(whole(image))), { signal })
                image.addEventListener("error", () => (settled.abort(), fail(reason)), { signal })
            })
        })

    // Draws the copy from the painted conductor's present file, with the bow and what lies under it at the same width. Each is a file
    // on its own, whose size is its pixels: the page's picture reports its size in CSS pixels, which the screen's density shrinks
    const draw = async () => {
        const source = mascot.currentSrc
        if (source === drawn) return
        const turn = ++asked
        const width = mascotWidthOf(source)
        if (!width) throw new Error(`the conductor's picture ${source} is none of its sizes`)
        const file = (address: string) => {
            const image = new Image()
            image.src = address
            return image
        }
        const painted = file(source)
        const cut = file(bowFile(width))
        const under = file(bowUnderFile(width))
        await Promise.all([painted.decode(), cut.decode(), under.decode()])
        if (released) throw new Error("released")
        if (turn !== asked) return
        // At the painted conductor's own size, so the copy is exactly as sharp. All of it in one task, so no frame shows it part drawn
        body.width = painted.naturalWidth
        body.height = painted.naturalHeight
        const pen = body.getContext("2d")
        if (!pen) throw new Error("no 2D canvas to draw the conductor without its bow")
        pen.drawImage(painted, 0, 0, body.width, body.height)
        pen.globalCompositeOperation = "destination-out"
        pen.drawImage(cut, 0, 0, body.width, body.height)
        pen.globalCompositeOperation = "source-over"
        pen.drawImage(under, 0, 0, body.width, body.height)
        drawn = source
    }
    // The painted conductor's file has changed with the window. Until the new copy is drawn the old one stands, only softer
    const follow = () => {
        if (released) return
        draw().catch((reason) => {
            if (!released) console.warn("The conductor's bow tie keeps its picture at the size it had:", reason)
        })
    }

    return {
        async load() {
            await whole(mascot)
            await Promise.all([whole(bow), draw()])
            if (released) throw new Error("released")
            // Over the painted conductor and under its face and cap, which come after it
            mascot.after(body)
            conductor.append(bow)
            mascot.addEventListener("load", follow)
            // The copy is drawn by now, so the painted conductor goes from under it a frame later, where the live bow's turns would
            // show its bow
            await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
            if (!released) mascot.style.visibility = "hidden"
            // A file the window picked while this loaded
            follow()
        },
        render(part) {
            bow.style.transform = `scale(${part.scaleX.toFixed(5)}, ${part.scaleY.toFixed(5)}) rotate(${part.turn.toFixed(5)}rad)`
        },
        release() {
            released = true
            mascot.removeEventListener("load", follow)
            mascot.style.visibility = ""
            body.remove()
            bow.remove()
        },
    }
}
