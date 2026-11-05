/**
 * Rule tables for optional input fields: Each rule pairs one accepted shape with the failure it reports.
 * Invariant: A table checks fields in its own key order, reads each supplied field once, skips undefined fields and
 * reports the first failure with that rule's fixed path suffix, constraint and explanation.
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */
import { type InputValidationConstraint, InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import { inputId, integerInRange, snapshotArray } from "./decode/primitives.js"
import { normalizedText, rawText } from "./field-text.js"

/** One field's accepted shape and the failure reported when a supplied value does not match it */
export interface FieldRule {
    /** Returns the value to keep, such as a frozen copy of an array, undefined to reject the value, or a failure of its own */
    readonly accept: (value: unknown) => unknown
    readonly constraint: InputValidationConstraint
    readonly explanation: string
    /** Appended to the field's path, "[]" for a rule about the items of a list */
    readonly suffix: string
}

export type FieldRules = Readonly<Record<string, FieldRule>>

/** A field whose value guard accepts unchanged */
export function field(
    guard: (value: unknown) => boolean,
    constraint: InputValidationConstraint,
    explanation: string,
): FieldRule {
    return { accept: (value) => (guard(value) ? value : undefined), constraint, explanation, suffix: "" }
}

/** A caller ID, kept trimmed as inputId returns it */
export const idField = (explanation: string): FieldRule => ({
    accept: inputId,
    constraint: "format",
    explanation,
    suffix: "",
})

export const booleanField = (explanation: string) => field((value) => typeof value === "boolean", "type", explanation)

export const choiceField = (values: readonly unknown[], explanation: string) =>
    field((value) => values.includes(value), "allowedValue", explanation)

/** A safe integer from minimum through maximum inclusive */
export const integerField = (minimum: number, maximum: number, explanation: string) =>
    field((value) => integerInRange(value, minimum, maximum), "range", explanation)

/** A string of minimum through maximum raw UTF-16 code units */
export const textField = (minimum: number, maximum: number, explanation: string) =>
    field((value) => rawText(value, minimum, maximum), "length", explanation)

/** A string of minimum through maximum UTF-16 code units after Fluxer's normalization, which removes U+000C and U+202E
 * and trims surrounding whitespace (packages/schema/src/primitives/SchemaPrimitives.ts:20-22, 176-183 at 0098958f). The
 * string is kept as given
 */
export const normalizedTextField = (minimum: number, maximum: number, explanation: string) =>
    field((value) => normalizedText(value, minimum, maximum), "length", explanation)

/** An array of at most maximum items that each pass item, kept as a frozen copy read once */
export function listField(
    maximum: number,
    item: (value: unknown) => boolean,
    constraint: InputValidationConstraint,
    explanation: string,
): FieldRule {
    const accept = (value: unknown) => {
        const items = snapshotArray(value, maximum)
        return items?.every((entry) => item(entry)) ? items : undefined
    }
    return { accept, constraint, explanation, suffix: "[]" }
}

/** The same list rule, also rejecting repeated items */
export function distinct(rule: FieldRule): FieldRule {
    const accept = (value: unknown) => {
        const items = rule.accept(value) as readonly unknown[] | undefined
        return items && new Set(items).size === items.length ? items : undefined
    }
    return { ...rule, accept }
}

/** A field whose check reports its own failures. check returns the value to keep or the failure, never undefined */
export function checkedField(check: (value: unknown) => unknown): FieldRule {
    // checkFields returns the failure that check gives, so this constraint and explanation are never reported
    return { accept: check, constraint: "format", explanation: "", suffix: "" }
}

/** The same rule, also accepting null */
export function nullable(rule: FieldRule): FieldRule {
    return { ...rule, accept: (value) => (value === null ? null : rule.accept(value)) }
}

/** The same rule, also accepting null and an empty string, which is sent as given. Routes that read their body through
 * Fluxer's Validator turn an empty string into null before checking it (fluxer_api/src/api/Validator.ts:59-63 at
 * 0098958f), so on a nullable field it means the same as null
 */
export function nullOrEmpty(rule: FieldRule): FieldRule {
    return { ...rule, accept: (value) => (value === null || value === "" ? value : rule.accept(value)) }
}

/** Predicate for list items of 1 through maximum UTF-16 code units after Fluxer's normalization, see normalizedTextField */
export const normalizedTextOf = (maximum: number) => (value: unknown) => normalizedText(value, 1, maximum)

/** Predicate for list items in values */
export const oneOf = (values: ReadonlySet<unknown>) => (value: unknown) => values.has(value)

/**
 * Check every supplied field of input that rules lists, in the order of rules, reading each field once.
 * Returns the kept values of the supplied fields, or the first failure, whose path is prefix, the key and the rule's suffix
 */
export function checkFields(
    input: Record<string, unknown>,
    rules: FieldRules,
    prefix: string,
): Record<string, unknown> | InputValidationFailure {
    const kept: Record<string, unknown> = {}
    for (const [key, rule] of Object.entries(rules)) {
        const value = input[key]
        if (value === undefined) continue
        const accepted = rule.accept(value)
        if (accepted instanceof InputValidationFailure) return accepted
        if (accepted === undefined)
            return inputValidationFailure(`${prefix}${key}${rule.suffix}`, rule.constraint, rule.explanation)
        kept[key] = accepted
    }
    return kept
}

/** Rename the kept values of supplied fields to their wire names, in the order of names */
export function wireFields(
    kept: Record<string, unknown>,
    names: Readonly<Record<string, string>>,
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(names).flatMap(([key, wire]) => (kept[key] === undefined ? [] : [[wire, kept[key]]])),
    )
}
