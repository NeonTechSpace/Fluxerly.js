// What the conductor's face does with time: blinks, glances, a brow lifted now and then, cheeks that rock, a mouth that
// ripples, a cap that fills with the breath and a bow tie that wiggles now and then. It only decides, in pixels of the 2048 canvas, and src/scene/face.ts draws. At wake 0 every part stands exactly as
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
    // How far the body has breathed in, and how full the waves' charge is, each 0 to 1. The cap fills with both
    breath: number
    charge: number
}

export interface FaceState {
    eyes: [FacePart, FacePart]
    brows: [FacePart, FacePart]
    cheeks: [FacePart, FacePart]
    // The whole cap, then its fan and its fold, which swell further inside it
    cap: { whole: FacePart; fan: FacePart; fold: FacePart }
    // The bow tie, turned and grown from its knot
    bow: FacePart
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
// How far the eyes travel at the end of a look, in canvas pixels. Then quick moves between places, as eyes make them, that
// start and land softly: a spring that settles in about a third of a second without overshooting
const eyeTravel = 22
const lookMin = 1.1
const lookMax = 4.2
const lookSpring = 13
// A brow lifted alone now and then, and how far
const browMin = 5
const browMax = 11
const browRise = 15
const browHold = 1.1
// The cap fills like a balloon from its band as the body breathes in and as the waves charge, a moment after them, and its fan
// and fold swell after the cap as the air rises. Calmer than the conductor at the end of the page: how far each grows, as a
// share of its size, and how many seconds each follows behind. It only ever grows, so the painted cap never shows behind it
const capBreath = { x: 0.007, y: 0.018 }
const capCharge = { x: 0.005, y: 0.014 }
const fanSwell = { x: 0.012, y: 0.04 }
const foldSwell = { x: 0.006, y: 0.018 }
const capLag = 0.4
const foldLag = 0.6
const fanLag = 0.9
// And it tips a little the way the eyes look, in radians
const capTip = 0.004
// The bow tie wiggles every five seconds or so, in the rhythm's quiet moments: a few small swings from its knot that start softly
// and die away. How far it turns at most, in radians, how long one swing and the whole wiggle take, and how much it swells
const bowMin = 4.3
const bowMax = 5.9
const bowTurn = 0.065
const bowSwing = 0.5
const bowSeconds = 1.6
const bowSwell = 0.015

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

// One wiggle of the bow tie by its age in seconds, from -1 to 1: swings that ease in and die away, still at both ends
export function wiggle(age: number): number {
    if (age <= 0 || age >= bowSeconds) return 0
    const k = age / bowSeconds
    const ease = Math.min(1, age / (bowSwing * 0.5))
    return Math.sin((tau * age) / bowSwing) * ease * ease * (3 - 2 * ease) * (1 - k) ** 2
}

// How far the bow swells as it wiggles, 0 to 1, rising and falling once with no jump
const wiggleSwell = (age: number) => (age <= 0 || age >= bowSeconds ? 0 : Math.sin((Math.PI * age) / bowSeconds) ** 2)

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

    let bowAt = -10
    let nextBow = 0
    const scheduleBow = (after: number) => {
        let at = after + between(bowMin, bowMax)
        for (let tries = 0; tries < 12 && !quietAt(at); tries++) at = after + between(bowMin, bowMax)
        nextBow = at
    }
    scheduleBow(0)

    let lookAt = 1.5
    const wander = { x: 0, y: 0 }
    const eyes = { x: 0, y: 0, vx: 0, vy: 0 }
    const air = { cap: 0, charge: 0, fold: 0, fan: 0 }
    const brow = { which: 0, at: -100, next: 4 }
    let last = 0

    const state: FaceState = {
        eyes: [part(), part()],
        brows: [part(), part()],
        cheeks: [part(), part()],
        cap: { whole: part(), fan: part(), fold: part() },
        bow: part(),
        gaze: { x: 0, y: 0 },
        joy: 0,
    }

    return {
        // Blinks now, as when something catches its eye
        blink(at: number) {
            blinkAt = at
            blinkDouble = false
        },
        update({ time: t, wake, gaze, attention, joy, breath, charge }: FaceMood): FaceState {
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
            // The spring's exact step, so a long frame lands where many short ones would
            const decay = Math.exp(-step * lookSpring)
            const pullX = (eyes.vx + lookSpring * (eyes.x - target.x)) * step
            const pullY = (eyes.vy + lookSpring * (eyes.y - target.y)) * step
            eyes.x = target.x + (eyes.x - target.x + pullX) * decay
            eyes.y = target.y + (eyes.y - target.y + pullY) * decay
            eyes.vx = (eyes.vx - lookSpring * pullX) * decay
            eyes.vy = (eyes.vy - lookSpring * pullY) * decay

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

            // Each layer of air follows the one below it, so the cap fills after the breath and the fan after the cap
            const follow = (from: number, to: number, lag: number) => from + (to - from) * (1 - Math.exp(-step / lag))
            air.cap = follow(air.cap, breath, capLag)
            air.charge = follow(air.charge, charge, capLag)
            const filled = Math.max(air.cap, air.charge)
            air.fold = follow(air.fold, filled, foldLag)
            air.fan = follow(air.fan, filled, fanLag)
            const { whole, fan, fold } = state.cap
            whole.scaleX = 1 + (capBreath.x * air.cap + capCharge.x * air.charge) * wake
            whole.scaleY = 1 + (capBreath.y * air.cap + capCharge.y * air.charge) * wake
            whole.turn = gazeX * capTip
            fold.scaleX = 1 + foldSwell.x * air.fold * wake
            fold.scaleY = 1 + foldSwell.y * air.fold * wake
            fan.scaleX = 1 + fanSwell.x * air.fan * wake
            fan.scaleY = 1 + fanSwell.y * air.fan * wake

            if (t >= nextBow) {
                // A late frame skips a missed one
                if (t - nextBow < 0.5) bowAt = nextBow
                scheduleBow(Math.max(t, nextBow))
            }
            state.bow.turn = bowTurn * wiggle(t - bowAt) * wake
            state.bow.scaleX = state.bow.scaleY = 1 + bowSwell * wiggleSwell(t - bowAt) * wake
            return state
        },
    }
}
