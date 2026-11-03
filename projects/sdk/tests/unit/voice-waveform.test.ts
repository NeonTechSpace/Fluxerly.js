import { expect, test } from "vitest"
import * as defaultApi from "../../src/index.js"
import * as native from "../../src/effect.js"

const generate = (length: number, sample: (index: number) => number) =>
    Float32Array.from({ length }, (_, i) => sample(i))

// Expected values come from running Fluxer's own buildWaveformBytes and computeVoiceWaveformFromAudioBuffer
// (fluxer_app/src/features/voice/utils/VoiceMessageRecordingUtils.ts:22 to 58 and :84 to 98 at 5f3fc0b1) on the same samples
const fluxerResults: ReadonlyArray<readonly [string, Float32Array, number, { duration: number; waveform: string }]> = [
    [
        "speech-like audio of 24 slices",
        generate(18_800, (i) => Math.sin(i * 0.37) * ((i % 997) / 997)),
        8_000,
        { duration: 2, waveform: "1ur3/fLe7/r/4+X0/P/W6/f+8d7w+v/i" },
    ],
    [
        "audio longer than 256 slices, with samples after the last full slice",
        generate(30_000, (i) => (Math.sin(i * 0.11) * (1 + Math.sin(i / 900))) / 2),
        1_000,
        {
            duration: 30,
            waveform:
                "uMPN1+Do7vP2+fv8/f38+fTv5+DXz8W7sKSXiXprXE0+Lh8PCBcmNkZVZHOBkJ6qtsHK09vj6/H3+v39/fz6+PXx6+Xc08i+sqebjoByYlJCMiMUBhAgMUFRYG99ipelsb7J0tvi6O7z9/v+///9+fXw6+Xe187DuKuekYN2Z1lJOSgYCQwbKzpKWmp5h5WhrbjDztjg6O7z9vn7/P39/Pn07ufg18/FvLCkl4l6a1xNPi4eDwgXJjZGVWRzgZCeq7bBytPb5Ovy9/r9/f38+vj18evk3NPIvbKnm46AcmJSQjIjFAYQIDFBUWBvfYqYpbK+ydLb4uju8/f7/v///Q==",
        },
    ],
    [
        "fewer samples than slices",
        Float32Array.from([0.5, -0.25, 1]),
        2,
        { duration: 2, waveform: "tID/AAAAAAAAAAAAAAAA" },
    ],
    [
        "a duration of 2.5 seconds, rounded up",
        generate(25, (i) => (i % 5) / 5 - 0.4),
        10,
        { duration: 3, waveform: "/7QAtP//tAC0//+0ALT//7QAtP//tAC0/w==" },
    ],
    ["silence", new Float32Array(4_000), 8_000, { duration: 1, waveform: "AAAAAAA=" }],
    ["no samples", new Float32Array(0), 48_000, { duration: 1, waveform: "AA==" }],
]

test.each(fluxerResults)("matches Fluxer's apps for %s", (_name, samples, sampleRate, expected) => {
    const result = defaultApi.voiceWaveform(samples, sampleRate)
    expect(result).toEqual(expected)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Buffer.from(result.waveform, "base64").length).toBeLessThanOrEqual(256)
    // The native API exports the same pure helper
    expect(native.voiceWaveform(samples, sampleRate)).toEqual(expected)
})

test("gives the same waveform for 16-bit integer samples, a plain array and an array-like object", () => {
    const [, floats, sampleRate, expected] = fluxerResults[0]!
    const integers = Int16Array.from(floats, (sample) => Math.round(sample * 16_384))
    // Rounding to integers changes the samples slightly, so compare with the float result of the same rounded values
    const rounded = Array.from(integers, (sample) => sample / 16_384)
    expect(defaultApi.voiceWaveform(integers, sampleRate)).toEqual(defaultApi.voiceWaveform(rounded, sampleRate))
    expect(defaultApi.voiceWaveform(Array.from(floats), sampleRate)).toEqual(expected)
    expect(defaultApi.voiceWaveform({ length: 3, 0: 0.5, 1: -0.25, 2: 1 }, 2)).toEqual(fluxerResults[2]![3])
})

test.each([
    ["a NaN sample inside a slice", [0.1, Number.NaN, 0.2], 10],
    ["an infinite sample after the last full slice", [...new Array(30).fill(0.1), Infinity], 100],
    ["a missing sample", [0.1, undefined, 0.2], 10],
    ["a bigint typed array", new BigInt64Array(4), 10],
    ["a DataView", new DataView(new ArrayBuffer(8)), 10],
    ["a string", "0.1", 10],
    ["an object without a length", { 0: 0.1 }, 10],
    ["a negative length", { length: -1 }, 10],
    ["a zero sample rate", [0.1], 0],
    ["a negative sample rate", [0.1], -48_000],
    ["an infinite sample rate", [0.1], Infinity],
    ["a sample rate given as text", [0.1], "48000"],
])("throws HelperError with reason audio for %s, without its values", (_name, samples, sampleRate) => {
    let failure: unknown
    try {
        defaultApi.voiceWaveform(samples as never, sampleRate as never)
    } catch (error) {
        failure = error
    }
    expect(failure).toBeInstanceOf(defaultApi.HelperError)
    expect(failure).toMatchObject({ operation: "voiceWaveform", reason: "audio", code: "helper.audio" })
    expect((failure as Error).message).not.toContain("48000")
})

// Webhook sends read waveforms of at most 256 characters, and the helper documents the longest audio that fits
test.each([
    ["default", defaultApi.voiceWaveform],
    ["native", native.voiceWaveform],
] as const)("%s voiceWaveform fits a webhook waveform for audio up to 19.2 seconds", (_mode, voiceWaveform) => {
    expect(voiceWaveform(new Float32Array(1_920), 100).waveform).toHaveLength(256)
    expect(voiceWaveform(new Float32Array(1_921), 100).waveform.length).toBeGreaterThan(256)
})

// Webhook sends read waveforms of at most 256 characters, the Base64 text of 192 bytes, so a smaller point count fits
// audio of any length while the default keeps Fluxer's 256 points
test.each([
    ["default", defaultApi.voiceWaveform],
    ["native", native.voiceWaveform],
] as const)("%s voiceWaveform limits its points to options.maxPoints", (_mode, voiceWaveform) => {
    const [, samples, sampleRate, expected] = fluxerResults[1]!
    const fitted = voiceWaveform(samples, sampleRate, { maxPoints: 192 })
    expect(fitted.duration).toBe(30)
    expect(fitted.waveform).toHaveLength(256)
    expect(Buffer.from(fitted.waveform, "base64")).toHaveLength(192)
    expect(Object.isFrozen(fitted)).toBe(true)
    // The loudest slice still scales to 255
    expect(Math.max(...Buffer.from(fitted.waveform, "base64"))).toBe(255)
    // The default and an explicit 256 keep Fluxer's result
    expect(voiceWaveform(samples, sampleRate, { maxPoints: 256 })).toEqual(expected)
    expect(voiceWaveform(samples, sampleRate, {})).toEqual(expected)
    // Audio short enough for fewer points than the cap is unchanged
    const [, short, shortRate, shortExpected] = fluxerResults[0]!
    expect(voiceWaveform(short, shortRate, { maxPoints: 192 })).toEqual(shortExpected)
    expect(Buffer.from(voiceWaveform(samples, sampleRate, { maxPoints: 1 }).waveform, "base64")).toEqual(
        Buffer.from([255]),
    )
})

test.each([
    ["zero points", { maxPoints: 0 }],
    ["more than 256 points", { maxPoints: 257 }],
    ["a fractional point count", { maxPoints: 191.5 }],
    ["a point count given as text", { maxPoints: "192" }],
    ["an unknown option", { maxPoints: 192, points: 192 }],
    ["options that are not an object", 192],
    ["null options", null],
])("throws HelperError with reason limit for %s", (_name, options) => {
    for (const voiceWaveform of [defaultApi.voiceWaveform, native.voiceWaveform]) {
        let failure: unknown
        try {
            voiceWaveform([0.1, 0.2], 10, options as never)
        } catch (error) {
            failure = error
        }
        expect(failure).toBeInstanceOf(defaultApi.HelperError)
        expect(failure).toMatchObject({ operation: "voiceWaveform", reason: "limit", code: "helper.limit" })
    }
})
