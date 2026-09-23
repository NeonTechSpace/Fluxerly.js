/** Identifies why the SDK rejected an input before sending a request. The rule may concern its type, allowed range, format or relationship to another field.
 * These categories do not describe Fluxer errors and are not ready-made messages for users
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
 * Paths and explanations are SDK-authored, with no arbitrary caller keys, rejected values or provider responses.
 * Write your own user-facing messages rather than displaying this diagnostic as application copy
 *
 * @example
 * ```ts
 * import type { InputValidationDetail, MessageOperationFailure } from "@neontechspace/fluxerly"
 * export function readInputValidation(error: MessageOperationFailure): InputValidationDetail | null {
 *     return error._tag === "MessageOperationError" ? error.inputValidation : null
 * }
 * ```
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
