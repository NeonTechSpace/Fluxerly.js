import { err, ok, type Result } from "neverthrow"
import { HelperError } from "./helpers.js"

/** A three-item array of red, green and blue amounts, in that order. Each must be an integer from 0 through 255 */
export type RgbColor = readonly [red: number, green: number, blue: number]

/** A color accepted by `colors.parse`: A number from 0 through 0xffffff, six hexadecimal digits such as `"#ff8800"`, or `[255, 136, 0] */
export type ColorInput = number | string | RgbColor

function validColor(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff
}

/** Convert colors locally before using them in an embed or role. Methods return a Result immediately, with a value on success or HelperError on failure */
export const colors: Readonly<{
    /** Convert a six-digit hexadecimal string, RGB array or color number to the integer used by embeds and roles.
     * The leading `#` is optional. CSS names, three-digit shorthand, alpha channels and surrounding whitespace fail.
     * Values are never rounded or clamped. An invalid input returns HelperError rather than a replacement color
     */
    parse(value: ColorInput): Result<number, HelperError>
    /** Turn a color integer into a lowercase six-digit string such as `"#000001"`.
     * Accepts only integers from 0 through 0xffffff, not the strings or arrays accepted by `parse`.
     * Invalid numbers return HelperError
     */
    toHex(value: number): Result<string, HelperError>
    /** Separate a color integer into a new frozen `[red, green, blue]` array, each from 0 through 255.
     * Accepts only integers from 0 through 0xffffff. Invalid numbers return HelperError
     */
    toRgb(value: number): Result<RgbColor, HelperError>
}> = Object.freeze({
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
    toHex(value: number): Result<string, HelperError> {
        return validColor(value)
            ? ok(`#${value.toString(16).padStart(6, "0")}`)
            : err(new HelperError("colors.toHex", "color"))
    },
    toRgb(value: number): Result<RgbColor, HelperError> {
        return validColor(value)
            ? ok(Object.freeze([(value >> 16) & 255, (value >> 8) & 255, value & 255] as const))
            : err(new HelperError("colors.toRgb", "color"))
    },
})
