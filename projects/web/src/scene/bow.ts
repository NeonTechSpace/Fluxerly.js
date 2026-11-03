// The live conductor's bow tie, which wiggles from its knot as src/scene/face-life.ts decides. Nothing but the sky lies under most
// of the painted bow, so a turned copy over it would show the painted one behind. Instead the painted conductor leaves out the
// bow's own shape, what lay under the bow (the frame's rim) goes back in its place, and the live bow goes over both. At rest the
// three are the painted conductor again, so it takes over without being seen

import { bowSrcset, bowUnderSrcset } from "../lib/art"
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
    const under = picture(bowUnderSrcset)
    const bow = picture(bowSrcset)
    bow.style.transformOrigin = knot
    bow.style.willChange = "transform"
    bow.dataset.bow = ""
    let released = false

    return {
        async load() {
            await Promise.all([under.decode(), bow.decode()])
            if (released) throw new Error("released")
            conductor.append(under, bow)
            // Leaves the painted bow out of the painted conductor. Until the mask's picture is here nothing is left out, and the live
            // bow already covers it
            Object.assign(mascot.style, {
                maskImage: `linear-gradient(#000 0 0), url("${bow.currentSrc}")`,
                maskComposite: "exclude",
                maskSize: "100% 100%",
                maskRepeat: "no-repeat",
            })
        },
        render(part) {
            bow.style.transform = `scale(${part.scaleX.toFixed(5)}, ${part.scaleY.toFixed(5)}) rotate(${part.turn.toFixed(5)}rad)`
        },
        release() {
            released = true
            for (const name of ["maskImage", "maskComposite", "maskSize", "maskRepeat"] as const) mascot.style[name] = ""
            under.remove()
            bow.remove()
        },
    }
}
