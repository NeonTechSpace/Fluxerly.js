import assert from "node:assert/strict"
import { test } from "node:test"
import { createFaceLife, lid } from "../src/scene/face-life.ts"

// The live face takes over from the painted glass, so with nothing awake every part must stand exactly as painted. And the
// eyes must open again however a blink lands

const mood = { gaze: null, attention: 0, joy: 0 }

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
        const state = life.update({ ...mood, time, wake: 0 })
        for (const part of [...state.eyes, ...state.brows, ...state.cheeks]) {
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
