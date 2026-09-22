export type FieldDirection = "request" | "response" | "gateway"

export type FieldDefaultRule =
    /** A required input or observation with no fallback. */
    | Readonly<{ kind: "none"; detail: string }>
    /** Optional absence is preserved on the wire or in the public projection. */
    | Readonly<{ kind: "omitted"; detail: string }>
    /** A concrete fallback supplied by the SDK. */
    | Readonly<{ kind: "value"; value: string; detail: string }>
    /** The SDK omits the wire field and the pinned provider applies its documented fallback. */
    | Readonly<{ kind: "provider"; detail: string }>

export type FieldLengthRule =
    | Readonly<{
          kind: "bounded"
          unit: "UTF-16-code-units" | "Unicode-code-points" | "bytes" | "items" | "milliseconds" | "seconds"
          minimum?: number
          maximum?: number
          detail: string
      }>
    | Readonly<{ kind: "not-applicable" | "delegated"; detail: string }>

export type FieldNormalizationRule =
    | Readonly<{ kind: "preserved" | "canonicalized" | "provider-normalized-view"; detail: string }>
    | Readonly<{ kind: "not-applicable" | "delegated"; detail: string }>

/** Authored facts that cannot be recovered from a TypeScript field shape. */
export interface FieldRuleAnnotation {
    /** `PublicType.field` or `Namespace.operation(parameter)` from the source-derived field inventory. */
    readonly target: string
    readonly direction: FieldDirection
    readonly providerOwner: `${string}.ts${string}` | `${string}.md${string}`
    readonly sdkOwner: `src/${string}.ts${string}`
    readonly default: FieldDefaultRule
    readonly length: FieldLengthRule
    readonly normalization: FieldNormalizationRule
    readonly executableEvidence: readonly `tests/${string}`[]
}

/** A narrow exclusion for an SDK-local field with no provider field contract. */
export interface LocalFieldExclusion {
    readonly target: string
    readonly direction: FieldDirection
    readonly rationale: string
    readonly sdkOwner: `src/${string}.ts${string}`
    readonly executableEvidence: readonly `tests/${string}`[]
}

export function defineFieldRules<const T extends readonly FieldRuleAnnotation[]>(rules: T): T {
    return rules
}

export function defineLocalFieldExclusions<const T extends readonly LocalFieldExclusion[]>(exclusions: T): T {
    return exclusions
}

export interface FieldRuleCoverage {
    readonly duplicateTargets: readonly string[]
    readonly unknownTargets: readonly string[]
    readonly unclassifiedTargets: readonly string[]
    readonly delegatedTargets: readonly string[]
}

/** Compares authored rules with an independently source-derived set of exact field keys. */
export function fieldRuleCoverage(
    expectedTargets: readonly `${FieldDirection}:${string}`[],
    rules: readonly FieldRuleAnnotation[],
    exclusions: readonly LocalFieldExclusion[],
): FieldRuleCoverage {
    const expected = new Set<string>(expectedTargets)
    const classified = [
        ...rules.map((rule) => `${rule.direction}:${rule.target}` as const),
        ...exclusions.map((exclusion) => `${exclusion.direction}:${exclusion.target}` as const),
    ]
    const counts = new Map<string, number>()
    for (const target of classified) counts.set(target, (counts.get(target) ?? 0) + 1)
    return Object.freeze({
        duplicateTargets: Object.freeze(
            [...counts]
                .filter(([, count]) => count > 1)
                .map(([target]) => target)
                .sort(),
        ),
        unknownTargets: Object.freeze([...counts.keys()].filter((target) => !expected.has(target)).sort()),
        unclassifiedTargets: Object.freeze([...expected].filter((target) => !counts.has(target)).sort()),
        delegatedTargets: Object.freeze(
            rules
                .filter((rule) => rule.length.kind === "delegated" || rule.normalization.kind === "delegated")
                .map((rule) => `${rule.direction}:${rule.target}`)
                .sort(),
        ),
    })
}
