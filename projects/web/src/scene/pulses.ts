// Messages on their way to the host: small cyan lights that run along the ribbon's thread from
// the lower left and arrive at the conductor, three in each breath of its waves. Everything follows
// from the scene time alone, so nothing is stored between frames and scene time zero, the Still
// frame, shows none.

import type { Vector3 } from "three"
import { arrivalTime, firstMessageAround, noise } from "./rhythm"

// Seconds on the way, a little longer or shorter per message
const travel = 4.8
const travelSpread = 0.2
// Where a message appears along the ribbon, as a share of the hero width
const start = 0.02
// How long the water under the conductor carries the ring a message leaves
export const ringSeconds = 3.4
// Messages that can matter at one time: the ones of this breath and of its neighbours
const nearby = 9

const lasts = (n: number) => travel * (1 + (noise(n, 2) - 0.5) * travelSpread)

// Fills where up to three messages are along the ribbon (as a share of the hero width) and how
// bright each one is. `end` is where the ribbon passes behind the conductor
export function placePulses(time: number, end: number, along: Vector3, strength: Vector3) {
    along.set(-1, -1, -1)
    strength.set(0, 0, 0)
    const first = firstMessageAround(time)
    for (let n = first; n < first + nearby; n++) {
        const u = 1 - (arrivalTime(n) - time) / lasts(n)
        if (u <= 0 || u >= 1) continue
        // Slower as it sets out and as it arrives, quicker in between
        const eased = u - (0.4 * Math.sin(u * Math.PI * 2)) / (Math.PI * 2)
        const x = start + (end - start) * eased
        const fade = Math.min(1, u / 0.12) * Math.min(1, (1 - u) / 0.1)
        along.setComponent(n % 3, x)
        strength.setComponent(n % 3, fade)
    }
}

// Seconds since the latest message reached the conductor, or -1 before the first one
export function sinceArrival(time: number) {
    const first = firstMessageAround(time)
    let since = -1
    for (let n = first; n < first + nearby; n++) {
        const s = time - arrivalTime(n)
        if (s >= 0 && (since < 0 || s < since)) since = s
    }
    return since
}
