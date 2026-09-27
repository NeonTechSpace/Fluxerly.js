import { err, ok, type Result } from "neverthrow"
import { HelperError, valueOrThrow } from "./helpers.js"

/**
 * A three-item array of red, green and blue amounts, in that order. Each must be an integer from 0 through 255
 *
 * @category Builders and formatting
 */
export type RgbColor = readonly [red: number, green: number, blue: number]

/**
 * A color accepted by `colors.parse`: A number from 0 through 0xffffff, six hexadecimal digits such as `"#ff8800"`, or `[255, 136, 0]`
 *
 * @category Builders and formatting
 */
export type ColorInput = number | string | RgbColor

function validColor(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff
}

function validRgbChannel(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255
}

/**
 * Methods of the colors helper, which converts RGB numbers, hex strings and tuples.
 * Most methods return plain values and throw HelperError for invalid input.
 * The tryParse method accepts untrusted input and returns a Result instead of throwing
 *
 * @category Builders and formatting
 */
export type ColorHelpers = Readonly<{
    /**
     * Convert a six-digit hexadecimal string, an RGB array of three integer channels from 0 through 255, or a color number to the integer used by embeds and roles.
     * The leading `#` is optional.
     * CSS names, three-digit shorthand, alpha channels and surrounding whitespace are rejected.
     * Values are never rounded or clamped, and invalid input throws HelperError.
     * For colors received from users, use tryParse, which reports the same HelperError without throwing
     */
    parse(value: ColorInput): number
    /**
     * Convert a color with the same rules as parse, but report invalid input without throwing.
     * The default API returns a Result holding the color integer or HelperError.
     * The native API returns an Effect that reads the input when run and fails with HelperError.
     * Use it for colors received from users or other untrusted sources
     */
    tryParse(value: ColorInput): Result<number, HelperError>
    /**
     * Turn a color integer into a lowercase six-digit string such as `"#000001"`, including leading zeroes.
     * Accepts only integers from 0 through 0xffffff, not the strings or arrays accepted by `parse`.
     * Throws HelperError for invalid numbers
     */
    toHex(value: number): string
    /**
     * Split a color integer into a new frozen `[red, green, blue]` array, each from 0 through 255.
     * Accepts only integers from 0 through 0xffffff.
     * Throws HelperError for invalid numbers
     */
    toRgb(value: number): RgbColor
}>

function parseColor(value: ColorInput): Result<number, HelperError> {
    if (validColor(value)) return ok(value)
    if (typeof value === "string" && /^#?[0-9a-fA-F]{6}$/u.test(value))
        return ok(Number.parseInt(value.startsWith("#") ? value.slice(1) : value, 16))
    if (Array.isArray(value) && value.length === 3) {
        const red = value[0]
        const green = value[1]
        const blue = value[2]
        if (validRgbChannel(red) && validRgbChannel(green) && validRgbChannel(blue))
            return ok((red << 16) | (green << 8) | blue)
    }
    return err(new HelperError("colors.parse", "color"))
}

/** Convert colors without a server request before using them in an embed or role.
 * Methods return plain values and throw HelperError for invalid input, while tryParse returns a Result
 */
export const colors: ColorHelpers = Object.freeze({
    parse: (value: ColorInput): number => valueOrThrow(parseColor(value)),
    tryParse: parseColor,
    toHex(value: number): string {
        if (!validColor(value)) throw new HelperError("colors.toHex", "color")
        return `#${value.toString(16).padStart(6, "0")}`
    },
    toRgb(value: number): RgbColor {
        if (!validColor(value)) throw new HelperError("colors.toRgb", "color")
        return Object.freeze([(value >> 16) & 255, (value >> 8) & 255, value & 255] as const)
    },
})
