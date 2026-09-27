import { unsupportedKeyHint } from "#sdk/internal/suggest"

/** Identifies why the SDK rejected an input before sending a request. The rule may concern its type, allowed range, format or relationship to another field.
 * These categories do not describe Fluxer errors and are not ready-made messages for users
 *
 * @category Errors
 */
export type InputValidationConstraint =
    | "required"
    | "type"
    | "format"
    | "range"
    | "length"
    | "allowedValue"
    | "allowedFields"
    | "relationship"
    | "unique"
    | "size"

/**
 * Describes why the SDK rejected an input without keeping the rejected value.
 * Read this detail from an operation error's inputValidation field when it is non-null.
 * The path names the input field, constraint names the rule, and explanation describes what the SDK accepts.
 * The SDK reports the first failure it can describe, not every invalid field.
 * Paths and explanations are SDK-authored, with no rejected values or provider responses.
 * Every operation input, query and options object rejects keys it does not support before sending, with constraint
 * allowedFields. The explanation names the key when it is a short identifier, such as a misspelled field name,
 * suggests the closest supported key and lists the supported keys.
 * Write application-specific user-facing messages rather than displaying this diagnostic as application copy
 *
 * @example
 * ```ts
 * import type { InputValidationDetail, MessageOperationFailure } from "@neontechspace/fluxerly"
 * export function readInputValidation(error: MessageOperationFailure): InputValidationDetail | null {
 *     return error._tag === "MessageOperationError" ? error.inputValidation : null
 * }
 * ```
 *
 * @category Errors
 */
export interface InputValidationDetail {
    /** Field or input path the SDK identified as invalid, without copying arbitrary caller keys */
    readonly path: string
    /** Kind of rule the input failed, suitable for application-specific error handling */
    readonly constraint: InputValidationConstraint
    /** Fixed SDK explanation of the accepted input, not the rejected value or ready-made application text */
    readonly explanation: string
}

/** @internal */
export class InputValidationFailure {
    constructor(readonly detail: InputValidationDetail) {}
}

/** @internal */
export function inputValidationFailure(
    path: string,
    constraint: InputValidationConstraint,
    explanation: string,
): InputValidationFailure {
    return new InputValidationFailure(Object.freeze({ path, constraint, explanation }))
}

/** @internal */
export function freezeInputValidationDetail(detail: InputValidationDetail | null): InputValidationDetail | null {
    return detail === null
        ? null
        : Object.freeze({ path: detail.path, constraint: detail.constraint, explanation: detail.explanation })
}

/** @internal Keys up to 64 characters that look like field names, so repeating one never copies arbitrary caller text */
const nameableKey = /^[A-Za-z_$][\w$]{0,63}$/

/**
 * @internal Reject the first own key of value that keys does not list, naming it with the closest supported key.
 * Each validator keeps its supported keys beside it. The path names the containing object, such as input or options,
 * and subject describes it in lowercase with its article, such as "the history query"
 */
export function unsupportedKeyFailure(
    value: object,
    keys: readonly string[],
    path: string,
    subject: string,
): InputValidationFailure | undefined {
    const key = Object.keys(value).find((candidate) => !keys.includes(candidate))
    if (key === undefined) return undefined
    const option = path === "options" || path.endsWith(".options")
    const unsupported = `Unsupported ${option ? "option" : "field"}${nameableKey.test(key) ? ` ${JSON.stringify(key)}` : ""}`
    return inputValidationFailure(
        path,
        "allowedFields",
        `${unsupported} in ${subject}. ${unsupportedKeyHint(key, keys, option ? "options" : "fields")}`,
    )
}
