import { expect, test } from "vitest"
import { voiceWaveform } from "../../src/voice-notes.js"
import {
    messageNoteSeconds,
    sampleRate,
    syntheticSamples,
    wavFile,
    webhookNoteSeconds,
} from "./support/voice-note-audio.js"

test("the WAV file is mono 16-bit PCM holding every sample", () => {
    const samples = Float32Array.from([0, 0.25, -0.25, 1, -1, 2, -2])
    const file = Buffer.from(wavFile(samples))
    expect(file.toString("ascii", 0, 4)).toBe("RIFF")
    expect(file.readUInt32LE(4)).toBe(file.length - 8)
    expect([file.toString("ascii", 8, 12), file.toString("ascii", 12, 16)]).toEqual(["WAVE", "fmt "])
    expect([file.readUInt32LE(16), file.readUInt16LE(20), file.readUInt16LE(22)]).toEqual([16, 1, 1])
    expect([file.readUInt32LE(24), file.readUInt32LE(28)]).toEqual([sampleRate, sampleRate * 2])
    expect([file.readUInt16LE(32), file.readUInt16LE(34)]).toEqual([2, 16])
    expect(file.toString("ascii", 36, 40)).toBe("data")
    expect(file.readUInt32LE(40)).toBe(samples.length * 2)
    const decoded = Array.from({ length: samples.length }, (_, index) => file.readInt16LE(44 + index * 2))
    // Values outside -1 through 1 are clamped
    expect(decoded).toEqual([0, 8_192, -8_192, 32_767, -32_767, 32_767, -32_767])
})

test("the synthetic tone gives a waveform with several bar heights", () => {
    const samples = syntheticSamples(messageNoteSeconds)
    expect(samples).toHaveLength(Math.round(messageNoteSeconds * sampleRate))
    expect(samples.every((sample) => sample >= -1 && sample <= 1)).toBe(true)
    const bytes = Buffer.from(voiceWaveform(samples, sampleRate).waveform, "base64")
    expect(new Set(bytes).size).toBeGreaterThan(5)
    expect(Math.max(...bytes)).toBe(255)
})

test.each([
    ["message", messageNoteSeconds, 2, 28],
    ["webhook", webhookNoteSeconds, 19, 256],
])(
    "the %s note's duration matches Fluxer's rounded-up measurement and its waveform fits",
    (_target, seconds, duration, waveformLength) => {
        const result = voiceWaveform(syntheticSamples(seconds), sampleRate)
        // Fluxer's media proxy rounds the measured length up to whole seconds
        expect(Math.ceil(seconds)).toBe(duration)
        expect(result.duration).toBe(duration)
        expect(result.waveform).toHaveLength(waveformLength)
    },
)
