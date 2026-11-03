// The live conductor's cap: the cloth of the cap apart, the same pictures the conductor at the end of the page fills, laid over the
// painted cap and moved as src/scene/face-life.ts decides. At rest they cover the painted cap exactly, and they only ever grow, so
// it can take over without being seen and the painted cap never shows behind it

import { mascotArt } from "../lib/art"
import type { FaceState } from "./face-life"

export interface Cap {
    // Loads the pictures and puts them on the conductor once they are decoded
    load(): Promise<void>
    render(cap: FaceState["cap"]): void
    release(): void
}

// Where the air comes in, as shares of the trimmed mascot: the whole cap grows from its band, the fan and the fold from under them
const capOrigin = "49.7% 45%"
const clothOrigin = "49.7% 33.5%"

const layer = <Element extends HTMLElement>(element: Element, origin: string) => {
    Object.assign(element.style, { position: "absolute", inset: "0", width: "100%", height: "100%", maxWidth: "none", transformOrigin: origin, willChange: "transform", pointerEvents: "none" })
    return element
}

const picture = (src: string) => {
    const image = new Image()
    image.alt = ""
    image.decoding = "async"
    image.src = src
    return layer(image, clothOrigin)
}

export function createCap(conductor: HTMLElement): Cap {
    const box = layer(document.createElement("div"), capOrigin)
    box.dataset.cap = ""
    const fan = picture(mascotArt.endingFan)
    const fold = picture(mascotArt.endingFold)
    const seat = picture(mascotArt.endingSeat)
    seat.style.willChange = ""
    box.append(fan, fold, seat)
    let released = false

    const transform = (part: FaceState["cap"]["whole"]) => `scale(${part.scaleX.toFixed(5)}, ${part.scaleY.toFixed(5)}) rotate(${part.turn.toFixed(5)}rad)`

    return {
        async load() {
            await Promise.all([fan, fold, seat].map((image) => image.decode()))
            if (released) throw new Error("released")
            conductor.append(box)
        },
        render({ whole, fan: fanState, fold: foldState }) {
            box.style.transform = transform(whole)
            fan.style.transform = transform(fanState)
            fold.style.transform = transform(foldState)
        },
        release() {
            released = true
            box.remove()
        },
    }
}
