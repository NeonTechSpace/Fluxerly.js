import { HelperError } from "./helpers.js"

/**
 * Duration and waveform of a voice note, ready to spread into a new attachment beside its data and filename
 *
 * @category Messages
 */
export interface VoiceWaveform {
    /** Length in whole seconds, rounded to the nearest second and at least 1, as Fluxer's apps send it.
     * Fluxer refuses a voice note longer than the instance allows, 1,200 seconds by default, and replaces this value with
     * the length it measures when it can read the file
     */
    readonly duration: number
    /** Base64 text of 1 through 256 amplitude bytes, one for each started 0.1 seconds of audio up to maxPoints, which
     * Fluxer's apps draw as the voice note's bars. Each byte is the square root of a slice's loudness relative to the loudest slice,
     * scaled to 0 through 255. Silent audio gives zero bytes
     */
    readonly waveform: string
}

/** Options for voiceWaveform
 *
 * @category Messages
 */
export interface VoiceWaveformOptions {
    /** Most amplitude bytes in the waveform, an integer from 1 through 256. Defaults to 256, as in Fluxer's apps.
     * Audio longer than maxPoints tenths of a second is split into maxPoints equal slices instead, so each bar covers
     * more audio. Use 192 for a webhook send or reply, whose waveform holds at most 256 characters, the Base64 text of
     * 192 bytes, for audio of any length
     */
    readonly maxPoints?: number
}

/** At most this many waveform bytes by default, one per slice (fluxer_app/src/features/voice/utils/VoiceMessageRecordingUtils.ts:19 at 5f3fc0b1) */
const defaultMaxPoints = 256
/** One waveform byte per this many seconds of audio, until the most points are reached (VoiceMessageRecordingUtils.ts:20) */
const secondsPerPoint = 0.1

/**
 * Compute a voice note's duration and waveform from decoded audio samples, with the same steps as Fluxer's apps
 * (fluxer_app/src/features/voice/utils/VoiceMessageRecordingUtils.ts:22 to 58 and :84 to 98 at 5f3fc0b1), so the
 * bars match a note recorded in Fluxer.
 * The samples are one channel of PCM audio, the first channel when the audio has several, as Fluxer's apps read it.
 * Ordinary decoded PCM scales work, such as floats from -1 through 1 or 16-bit integers, because each slice is
 * measured against the loudest one. The SDK decodes no audio file. Decode the file first, for example with
 * `ffmpeg -i note.ogg -af 'pan=mono|c0=c0' -f f32le -`, which keeps only the first channel, and `new Float32Array`
 * over a copy of the output bytes, or with an audio library or a WAV reader. Exact parity with Fluxer's apps needs the
 * same first-channel samples at the same sample rate, which another decoder or resampling can change slightly.
 * The sample rate in hertz gives the duration, the number of samples divided by the rate.
 * Empty samples give a duration of 1 and one zero byte, as Fluxer's apps do. The result is a plain object and
 * nothing is sent. Pass it with the audio file's data, filename and an audio contentType to messages.send, a
 * reply or a forum post, with flags MessageFlags.VoiceMessage. A webhook send also accepts it while the waveform holds
 * at most 256 characters, which a result with the default options does for audio up to 19.2 seconds, and a result with
 * options.maxPoints of 192 does for audio of any length. Fluxer checks the duration limit, not this helper.
 * Throws HelperError with reason audio when samples is not an array, typed array or other array-like object of finite
 * numbers, or the sample rate is not a positive finite number, and with reason limit when options is not an object with
 * only maxPoints, an integer from 1 through 256. In Effect code such a throw becomes a defect
 *
 * @example
 * ```ts
 * import { MessageFlags, voiceWaveform } from "@neontechspace/fluxerly"
 *
 * // Samples of one 48 kHz channel, decoded from the file in data
 * export function voiceNoteMessage(data: Uint8Array, samples: Float32Array) {
 *     return {
 *         flags: MessageFlags.VoiceMessage,
 *         attachments: [{ data, filename: "note.ogg", contentType: "audio/ogg", ...voiceWaveform(samples, 48_000) }],
 *     }
 * }
 * ```
 *
 * @category Messages
 */
export function voiceWaveform(
    samples: ArrayLike<number>,
    sampleRate: number,
    options?: VoiceWaveformOptions,
): VoiceWaveform {
    const maxPoints = pointLimit(options)
    if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate <= 0)
        throw new HelperError("voiceWaveform", "audio")
    const length = typeof samples === "object" && samples !== null ? samples.length : undefined
    if (length === undefined || !Number.isSafeInteger(length) || length < 0)
        throw new HelperError("voiceWaveform", "audio")
    const seconds = length / sampleRate
    const points = Math.min(maxPoints, Math.max(1, Math.ceil(seconds / secondsPerPoint)))
    // Each slice holds the same whole number of samples, so samples after the last full slice are left out and a
    // recording shorter than its slice count leaves later slices empty, as in Fluxer's apps
    const perPoint = Math.max(1, Math.floor(length / points))
    const loudness = new Float64Array(points)
    let loudest = 0
    for (let point = 0; point < points; point++) {
        const start = point * perPoint
        const end = Math.min(length, start + perPoint)
        let sumOfSquares = 0
        for (let index = start; index < end; index++) {
            const sample = samples[index]
            if (typeof sample !== "number" || !Number.isFinite(sample)) throw new HelperError("voiceWaveform", "audio")
            sumOfSquares += sample * sample
        }
        const rms = end > start ? Math.sqrt(sumOfSquares / (end - start)) : 0
        loudness[point] = rms
        if (rms > loudest) loudest = rms
    }
    // Samples outside every slice still have to be numbers, so a bad value is reported wherever it is
    for (let index = points * perPoint; index < length; index++) {
        const sample = samples[index]
        if (typeof sample !== "number" || !Number.isFinite(sample)) throw new HelperError("voiceWaveform", "audio")
    }
    const bytes = new Uint8Array(points)
    if (loudest > 0)
        for (let point = 0; point < points; point++)
            bytes[point] = Math.min(
                255,
                Math.round(Math.sqrt(Math.max(0, Math.min(1, loudness[point]! / loudest))) * 255),
            )
    return Object.freeze({
        duration: Math.max(1, Math.round(seconds)),
        waveform: Buffer.from(bytes).toString("base64"),
    })
}

/** The most waveform bytes that options allow, or HelperError with reason limit for options that are not valid */
function pointLimit(options: VoiceWaveformOptions | undefined): number {
    if (options === undefined) return defaultMaxPoints
    if (typeof options !== "object" || options === null || Object.keys(options).some((key) => key !== "maxPoints"))
        throw new HelperError("voiceWaveform", "limit")
    const { maxPoints = defaultMaxPoints } = options
    if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > defaultMaxPoints)
        throw new HelperError("voiceWaveform", "limit")
    return maxPoints
}
