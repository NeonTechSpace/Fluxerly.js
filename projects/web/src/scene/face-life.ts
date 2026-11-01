// What the conductor's face does with time: blinks, glances, a brow lifted now and then, cheeks that rock and a mouth that
// ripples. It only decides, in pixels of the 2048 canvas, and src/scene/face.ts draws. At wake 0 every part stands exactly as
// painted, so the live face can take over from the picture without a jump

export interface FacePart {
    x: number
    y: number
    // Scale for the eyes, a turn in radians for the rest
    scaleX: number
    scaleY: number
    turn: number
}

export interface FaceMood {
    // The live scene's clock in seconds, and how much of the motion shows, 0 to 1
    time: number
    wake: number
    // Where the conductor looks, each from -1 to 1, or null to let it look around by itself
    gaze: { x: number; y: number } | null
    // Something has its attention, such as the pointer on its head, 0 to 1
    attention: number
    // Just pleased, such as a command copied, 0 to 1
    joy: number
}

export interface FaceState {
    eyes: [FacePart, FacePart]
    brows: [FacePart, FacePart]
    cheeks: [FacePart, FacePart]
    gaze: { x: number; y: number }
    joy: number
}

// Blinks: one every few seconds at random, now and then twice, each closing quickly and opening a little slower
const blinkMin = 3.4
const blinkMax = 7.5
const blinkTwice = 0.22
const blinkGap = 0.34
const blinkClose = 0.07
const blinkShut = 0.05
const blinkOpen = 0.16
const blinkLid = 0.07
// How far the eyes travel at the end of a look, in canvas pixels. Then quick moves between places, as eyes make them
const eyeTravel = 22
const lookMin = 1.1
const lookMax = 4.2
const lookSpeed = 11
// A brow lifted alone now and then, and how far
const browMin = 5
const browMax = 11
const browRise = 15
const browHold = 1.1

const tau = Math.PI * 2

// How far one blink has closed the eyes, from 1 open to the lid share shut, by its age in seconds
export function lid(age: number): number {
    if (age <= 0 || age >= blinkClose + blinkShut + blinkOpen) return 1
    if (age < blinkClose) {
        const k = age / blinkClose
        return 1 - (1 - blinkLid) * k * k
    }
    if (age < blinkClose + blinkShut) return blinkLid
    const k = (age - blinkClose - blinkShut) / blinkOpen
    return blinkLid + (1 - blinkLid) * (1 - (1 - k) * (1 - k))
}

const part = (): FacePart => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, turn: 0 })

// Takes a seeded random and the rhythm's quiet moments, which blinks land in so they don't compete with its other peaks
export function createFaceLife(random: () => number, quietAt: (time: number) => boolean) {
    const between = (from: number, to: number) => from + (to - from) * random()

    let blinkAt = -10
    let blinkDouble = false
    let nextBlink = 0
    const scheduleBlink = (after: number) => {
        let at = after + between(blinkMin, blinkMax)
        for (let tries = 0; tries < 12 && !quietAt(at); tries++) at = after + between(blinkMin, blinkMax)
        nextBlink = at
    }
    scheduleBlink(0)

    let lookAt = 1.5
    const wander = { x: 0, y: 0 }
    const eyes = { x: 0, y: 0 }
    const brow = { which: 0, at: -100, next: 4 }
    let last = 0

    const state: FaceState = { eyes: [part(), part()], brows: [part(), part()], cheeks: [part(), part()], gaze: { x: 0, y: 0 }, joy: 0 }

    return {
        // Blinks now, as when something catches its eye
        blink(at: number) {
            blinkAt = at
            blinkDouble = false
        },
        update({ time: t, wake, gaze, attention, joy }: FaceMood): FaceState {
            const step = Math.min(0.1, Math.max(0, t - last))
            last = t

            if (t >= nextBlink) {
                // A late frame skips a missed one
                if (t - nextBlink < 0.5 && wake > 0.5) {
                    blinkAt = nextBlink
                    blinkDouble = random() < blinkTwice
                }
                scheduleBlink(Math.max(t, nextBlink))
            }
            const age = t - blinkAt
            const shut = blinkDouble ? Math.min(lid(age), lid(age - blinkGap)) : lid(age)

            // Looking around: mostly near the middle, sometimes well to one side, and a move of the eyes often brings a blink
            if (t >= lookAt) {
                const far = random() < 0.3
                const reach = far ? 1 : 0.6
                wander.x = between(-reach, reach)
                wander.y = between(-reach * 0.7, reach * 0.7)
                lookAt = t + between(lookMin, lookMax)
                if (far && random() < 0.4 && age > 1) {
                    blinkAt = t
                    blinkDouble = false
                }
            }
            const target = gaze ?? wander
            const ease = 1 - Math.exp(-step * lookSpeed)
            eyes.x += (target.x - eyes.x) * ease
            eyes.y += (target.y - eyes.y) * ease

            if (t >= brow.next) {
                brow.which = Math.floor(random() * 3)
                brow.at = t
                brow.next = t + between(browMin, browMax)
            }
            const since = (t - brow.at) / browHold
            const lifted = since > 0 && since < 1 ? Math.sin(Math.PI * Math.min(1, since * 1.15)) ** 2 : 0

            const dip = 1 - shut
            const gazeX = eyes.x * wake
            const gazeY = eyes.y * wake
            state.gaze.x = gazeX
            state.gaze.y = gazeY
            state.joy = joy * wake

            state.eyes.forEach((eye, i) => {
                const breathe = 0.012 * Math.sin((tau * t) / (6.1 + i * 1.3) + i * 2) * wake
                eye.x = gazeX * eyeTravel
                eye.y = gazeY * eyeTravel * 0.72
                eye.scaleX = 1 + breathe + 0.035 * attention * wake - 0.02 * gazeX * (i === 0 ? 1 : -1) * Math.abs(gazeX)
                eye.scaleY = (1 - breathe * 0.6 + 0.04 * attention * wake - 0.2 * state.joy) * (1 - (1 - shut) * wake)
            })
            state.brows.forEach((one, i) => {
                const alone = brow.which === 2 || brow.which === i ? lifted : 0
                const sway = Math.sin((tau * t) / (7.3 + i * 2.1) + i * 1.7)
                one.x = (gazeX * 5 + sway * 3) * wake
                one.y = (-alone * browRise - attention * 8 - state.joy * 6 + dip * 7 + gazeY * 3 + 1.8 * Math.sin((tau * t) / (5.3 + i)) ) * wake
                // Each brow is the eye's roof: lifting tips its outer end up, and the eye's turn pulls it a little
                one.turn = (alone * 0.075 * (i === 0 ? 1 : -1) + sway * 0.018 + gazeX * 0.016) * wake
            })
            state.cheeks.forEach((one, i) => {
                const rock = Math.sin((tau * t) / (8.7 + i * 2.3) + i * 3)
                one.x = (Math.cos((tau * t) / (11 + i * 3)) * 3 * (i === 0 ? 1 : -1) + gazeX * 3) * wake
                one.y = (Math.sin((tau * t) / (6.7 + i * 1.4) + i) * 4 - attention * 3 - state.joy * 10 + gazeY * 2) * wake
                one.turn = rock * 0.07 * wake
            })
            return state
        },
    }
}
