// The hero's rhythm. One slow breath of the conductor's waves sets the beat, and every other event
// takes its own place in it: messages arrive while the waves are on their way down or up, the
// shooting star falls while they are at their darkest, and the eyes blink in the quiet between.
// So something always moves gently and two things never peak together. Everything follows from
// the scene time alone, and scene time zero, the Still frame, is the rest pose: the waves at the
// full charge they are painted with, and nothing on its way.

// One slow breath sets the beat
export const breathSeconds = 22

// Three messages arrive in each breath, never while the waves are full and never near the star.
// The first one leaves after the Still frame
const arrivals = [5.6, 12.6, 19.2]
const arrivalJitter = 0.25

// One shooting star in each breath, early in the climb, when the waves are darkest
const starFrom = 7.6
const starSpread = 2.2
export const starSeconds = 1

// Repeatable pseudo random value from 0 to 1
export function noise(n: number, salt: number) {
    const v = Math.sin(n * 12.9898 + salt * 78.233) * 43758.5453
    return v - Math.floor(v)
}


// When message n reaches the conductor, in scene seconds
export function arrivalTime(n: number) {
    return Math.floor(n / arrivals.length) * breathSeconds + arrivals[n % arrivals.length] + (noise(n, 1) - 0.5) * 2 * arrivalJitter
}

// When the latest message reached the conductor by this time, or nothing before the first one
export function lastArrival(time: number) {
    let latest = Number.NEGATIVE_INFINITY
    for (let n = firstMessageAround(time); arrivalTime(n) <= time; n++) latest = arrivalTime(n)
    return latest
}

// The first message that may still be on its way or answered at this time
export function firstMessageAround(time: number) {
    return Math.max(0, (Math.floor(time / breathSeconds) - 1) * arrivals.length)
}

// When the shooting star of a breath starts to fall
export function starStart(breath: number) {
    return breath * breathSeconds + starFrom + noise(breath, 5) * starSpread
}

// Whether a blink here stays clear of every other peak: the waves reaching full charge, a message
// arriving and the star
export function quietAt(time: number) {
    const breath = Math.floor(time / breathSeconds)
    const k = time - breath * breathSeconds
    if (k < 0.5 || k > breathSeconds - 0.5) return false
    const first = firstMessageAround(time)
    for (let n = first; n < first + arrivals.length * 3; n++) {
        if (Math.abs(time - arrivalTime(n)) < 0.6) return false
    }
    const star = starStart(breath)
    return time < star - 0.4 || time > star + starSeconds + 0.4
}
