/** Stable SDK-owned constraint for one locally rejected operation input */
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
 * Safe local-validation facts for an operation failure
 *
 * Paths and explanations are authored by the SDK. The detail never includes a rejected value, an arbitrary caller key,
 * a provider response, or presentation-ready application copy. Applications remain responsible for user-facing text.
 * When a validator supplies detail, it reports the first failed constraint in that operation's existing validation order
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
    /** Stable SDK-owned field or input path */
    readonly path: string
    /** Stable category of the failed constraint */
    readonly constraint: InputValidationConstraint
    /** Safe explanation of the accepted shape or relationship */
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
