import { err, ok, type Result } from "neverthrow"
import { HelperError } from "./helpers.js"

/** Red, green and blue integer channels, each from 0 through 255 */
export type RgbColor = readonly [red: number, green: number, blue: number]

/** An integer from 0 through 0xffffff, exactly six hexadecimal digits with optional #, or an RGB tuple. No CSS names, shorthand, alpha or whitespace */
export type ColorInput = number | string | RgbColor

function validColor(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff
}

/** Pure RGB conversion for message/embed and role configuration, without network work or CSS parsing */
export const colors = Object.freeze({
    /** Validate and convert ColorInput to its numeric RGB value without clamping, rounding or string coercion. Malformed inputs fail with HelperError and are not retained */
    parse(value: ColorInput): Result<number, HelperError> {
        if (validColor(value)) return ok(value)
        if (typeof value === "string" && /^#?[0-9a-fA-F]{6}$/u.test(value))
            return ok(Number.parseInt(value.startsWith("#") ? value.slice(1) : value, 16))
        if (
            Array.isArray(value) &&
            value.length === 3 &&
            Array.from(value).every(
                (channel) => typeof channel === "number" && Number.isInteger(channel) && channel >= 0 && channel <= 255,
            )
        )
            return ok((value[0]! << 16) | (value[1]! << 8) | value[2]!)
        return err(new HelperError("colors.parse", "color"))
    },
    /** Format a valid numeric RGB value as lowercase #rrggbb, preserving leading zeroes. Out-of-range or noninteger input fails */
    toHex(value: number): Result<string, HelperError> {
        return validColor(value)
            ? ok(`#${value.toString(16).padStart(6, "0")}`)
            : err(new HelperError("colors.toHex", "color"))
    },
    /** Return a new frozen [red, green, blue] tuple for a valid numeric RGB value. Out-of-range or noninteger input fails */
    toRgb(value: number): Result<RgbColor, HelperError> {
        return validColor(value)
            ? ok(Object.freeze([(value >> 16) & 255, (value >> 8) & 255, value & 255] as const))
            : err(new HelperError("colors.toRgb", "color"))
    },
})
