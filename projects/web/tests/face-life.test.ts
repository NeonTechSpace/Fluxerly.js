import assert from "node:assert/strict"
import { test } from "node:test"
import { createFaceLife, lid } from "../src/scene/face-life.ts"

// The live face takes over from the painted glass, so with nothing awake every part must stand exactly as painted. And the
// eyes must open again however a blink lands

const mood = { gaze: null, attention: 0, joy: 0, breath: 0, charge: 0 }
// The body's breath as the hero gives it, and a charge that fills and fades as the hero's does
const breathAt = (time: number) => 0.5 * (1 - Math.cos((2 * Math.PI * time) / 7.5))
const chargeAt = (time: number) => Math.max(0, Math.sin((2 * Math.PI * time) / 11)) ** 2

// A plain seeded random and a rhythm that is always quiet, so a run gives the same numbers every time
const seeded = () => {
    let seed = 4817
    return () => {
        seed = (seed * 16807) % 2147483647
        return seed / 2147483647
    }
}
const make = () => createFaceLife(seeded(), () => true)

test("at wake 0 every part of the face stands as painted, at any moment", () => {
    const life = make()
    for (let time = 0; time < 40; time += 0.25) {
        const state = life.update({ ...mood, time, wake: 0, breath: breathAt(time), charge: chargeAt(time) })
        const { whole, fan, fold } = state.cap
        for (const part of [...state.eyes, ...state.brows, ...state.cheeks, whole, fan, fold, state.bow]) {
            assert.equal(part.x + 0, 0)
            assert.equal(part.y + 0, 0)
            assert.equal(part.turn + 0, 0)
            assert.equal(part.scaleX, 1)
            assert.equal(part.scaleY, 1)
        }
    }
})

test("awake, each part of the face moves, and the two sides don't move as one", () => {
    const life = make()
    const range = new Map<string, number[]>()
    const note = (name: string, value: number) => {
        const seen = range.get(name) ?? [value, value]
        range.set(name, [Math.min(seen[0]!, value), Math.max(seen[1]!, value)])
    }
    let apart = 0
    for (let time = 0; time < 60; time += 1 / 30) {
        const state = life.update({ ...mood, time, wake: 1 })
        state.eyes.forEach((eye, side) => {
            note(`eye${side}x`, eye.x)
            note(`eye${side}open`, eye.scaleY)
        })
        state.brows.forEach((brow, side) => note(`brow${side}y`, brow.y))
        state.cheeks.forEach((cheek, side) => note(`cheek${side}turn`, cheek.turn))
        apart = Math.max(apart, Math.abs(state.brows[0].y - state.brows[1].y))
    }
    for (const [name, [low, high]] of range) assert.ok(high! - low! > 0.05, `${name} barely moves`)
    assert.ok(apart > 2, "the brows only ever move together")
})

test("a blink closes the eyes and opens them again", () => {
    assert.equal(lid(-1), 1)
    assert.ok(lid(0.09) < 0.1)
    assert.equal(lid(1), 1)
})

test("looking is bounded and holds the place it was told", () => {
    const life = make()
    let state = life.update({ ...mood, time: 0, wake: 1 })
    for (let time = 0; time < 5; time += 1 / 30) state = life.update({ ...mood, gaze: { x: 1, y: -1 }, time, wake: 1 })
    assert.ok(Math.abs(state.gaze.x - 1) < 0.01)
    assert.ok(Math.abs(state.gaze.y + 1) < 0.01)
})

// Frame by frame at 60 frames a second, as a screen shows it
const frames = (seconds: number, each: (time: number) => void) => {
    for (let frame = 0; frame <= seconds * 60; frame++) each(frame / 60)
}

test("the eyes glide from one look to the next, with no jump between two frames", () => {
    const life = make()
    let last: { x: number; y: number } | null = null
    let lastStep: { x: number; y: number } | null = null
    let fastest = 0
    let sharpest = 0
    frames(120, (time) => {
        const [eye] = life.update({ ...mood, time, wake: 1, breath: breathAt(time) }).eyes
        if (last) {
            const step = { x: eye.x - last.x, y: eye.y - last.y }
            fastest = Math.max(fastest, Math.hypot(step.x, step.y))
            // A change of speed in one frame: a look that starts at full speed is a jump to the eye
            if (lastStep) sharpest = Math.max(sharpest, Math.hypot(step.x - lastStep.x, step.y - lastStep.y))
            lastStep = step
        }
        last = { x: eye.x, y: eye.y }
    })
    // In pixels of the 2048 canvas, about a third of that on a desktop hero
    assert.ok(fastest > 0.5, "the eyes don't look around")
    assert.ok(fastest < 4, `the eyes move ${fastest.toFixed(1)} px in one frame`)
    assert.ok(sharpest < 2, `the eyes change speed by ${sharpest.toFixed(1)} px a frame in one frame`)
})

test("the cap fills with the breath and the charge, its fan after it, only ever grows and never jumps", () => {
    const life = make()
    let fullest = { whole: 1, fan: 1, charged: 1 }
    let smallest = 1
    let jump = 0
    let last: number[] | null = null
    let fanPeak = -1
    let wholePeak = -1
    let wholeTop = 0
    let fanTop = 0
    frames(30, (time) => {
        const { whole, fan, fold } = life.update({ ...mood, time, wake: 1, breath: breathAt(time) }).cap
        const now = [whole.scaleX, whole.scaleY, fan.scaleX, fan.scaleY, fold.scaleX, fold.scaleY, whole.turn]
        smallest = Math.min(smallest, ...now.slice(0, 6))
        if (last) jump = Math.max(jump, ...now.map((value, index) => Math.abs(value - last![index]!)))
        last = now
        // The first breath in a quiet face: the cap swells after the body, the fan after the cap
        if (time > 7.5 && time < 15) {
            if (whole.scaleY > wholeTop) [wholeTop, wholePeak] = [whole.scaleY, time]
            if (fan.scaleY > fanTop) [fanTop, fanPeak] = [fan.scaleY, time]
        }
        fullest = { ...fullest, whole: Math.max(fullest.whole, whole.scaleY), fan: Math.max(fullest.fan, fan.scaleY) }
    })
    const charged = make()
    frames(30, (time) => {
        const { whole } = charged.update({ ...mood, time, wake: 1, breath: breathAt(time), charge: chargeAt(time) }).cap
        fullest.charged = Math.max(fullest.charged, whole.scaleY)
    })
    assert.equal(smallest, 1, "the cap shrinks below its painted size, which shows the painted cap behind it")
    assert.ok(fullest.whole > 1.01 && fullest.whole < 1.04, `the cap fills to ${fullest.whole.toFixed(3)}`)
    assert.ok(fullest.fan > fullest.whole, "the fan doesn't swell inside the cap")
    assert.ok(fullest.charged > fullest.whole + 0.005, "a charge doesn't fill the cap")
    // The body is fullest at 11.25 seconds
    assert.ok(wholePeak > 11.25 && fanPeak > wholePeak, "the cap doesn't follow the breath, or the fan doesn't follow the cap")
    assert.ok(jump < 0.001, `the cap changes by ${jump.toFixed(4)} in one frame`)
})

test("the bow tie wiggles from its knot every five seconds or so, softly, and only ever grows", () => {
    const life = make()
    const starts: number[] = []
    let moving = false
    let widest = 0
    let fastest = 0
    let smallest = 1
    let last = 0
    frames(60, (time) => {
        const { bow } = life.update({ ...mood, time, wake: 1 })
        if (Math.abs(bow.turn) > 0.002 && !moving) starts.push(time)
        moving = Math.abs(bow.turn) > 0.002 || (moving && bow.scaleY > 1.0005)
        widest = Math.max(widest, Math.abs(bow.turn))
        fastest = Math.max(fastest, Math.abs(bow.turn - last))
        smallest = Math.min(smallest, bow.scaleX, bow.scaleY)
        last = bow.turn
        assert.equal(bow.x + bow.y, 0, "the bow tie leaves its knot")
    })
    const gaps = starts.slice(1).map((start, index) => start - starts[index]!)
    assert.ok(starts.length >= 9, `the bow tie wiggles ${starts.length} times in a minute`)
    assert.ok(gaps.every((gap) => gap > 4 && gap < 7), `the bow tie wiggles at ${gaps.map((gap) => gap.toFixed(1)).join(", ")} s apart`)
    // In radians: about 2 degrees at most, enough to see and calm
    assert.ok(widest > 0.03 && widest < 0.045, `the bow tie turns ${widest.toFixed(3)} rad at most`)
    assert.ok(fastest < 0.012, `the bow tie turns ${fastest.toFixed(4)} rad in one frame`)
    assert.equal(smallest, 1, "the bow tie shrinks below its painted size")
})
