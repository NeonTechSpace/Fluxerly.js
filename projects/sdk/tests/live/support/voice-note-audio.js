// Synthetic voice-note audio for the live voice-note check: A tone whose loudness changes every tenth of a second, so
// the waveform has distinct bars, encoded as a mono 16-bit PCM WAV file. No recorded audio or user file enters the check

/** Sample rate of the synthetic notes in hertz, low enough to keep the files small */
export const sampleRate = 8_000

// Fluxer replaces a voice note's duration with the length its media proxy measures, rounded up to whole seconds
// (fluxer_media_proxy/src/media_process/metadata.rs:232 to :236 at 5f3fc0b1), while voiceWaveform rounds to the
// nearest second. Each length sits just under a whole second, so both give the same value and the readback can
// compare them exactly
/** Length in seconds of the notes sent as a message and as a forum post: 19 waveform bytes and a duration of 2 */
export const messageNoteSeconds = 1.9
/** Length in seconds of the webhook note: 190 waveform bytes, whose Base64 text is exactly the 256 characters a webhook
 * send allows, and a duration of 19
 */
export const webhookNoteSeconds = 18.95

/** One channel of samples from -1 through 1 for `seconds` of audio: a 440 Hz tone whose amplitude steps every 0.1 s */
export function syntheticSamples(seconds) {
    const length = Math.round(seconds * sampleRate)
    const samples = new Float32Array(length)
    const sliceLength = sampleRate / 10
    for (let index = 0; index < length; index++) {
        const slice = Math.floor(index / sliceLength)
        const amplitude = 0.1 + (0.8 * ((slice * 7) % 10)) / 9
        samples[index] = amplitude * Math.sin((2 * Math.PI * 440 * index) / sampleRate)
    }
    return samples
}

/** A mono 16-bit PCM WAV file of the samples, clamped to -1 through 1 */
export function wavFile(samples, rate = sampleRate) {
    const dataLength = samples.length * 2
    const file = Buffer.alloc(44 + dataLength)
    file.write("RIFF", 0, "ascii")
    file.writeUInt32LE(36 + dataLength, 4)
    file.write("WAVE", 8, "ascii")
    file.write("fmt ", 12, "ascii")
    file.writeUInt32LE(16, 16)
    file.writeUInt16LE(1, 20)
    file.writeUInt16LE(1, 22)
    file.writeUInt32LE(rate, 24)
    file.writeUInt32LE(rate * 2, 28)
    file.writeUInt16LE(2, 32)
    file.writeUInt16LE(16, 34)
    file.write("data", 36, "ascii")
    file.writeUInt32LE(dataLength, 40)
    for (let index = 0; index < samples.length; index++)
        file.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32_767), 44 + index * 2)
    return new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
}
