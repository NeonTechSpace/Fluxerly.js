import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, test } from "vitest"
import { applicationMarked, inputDefect } from "../../src/internal/defects.js"
import { failures, keepConvertedFailures, mapCause, mapFailureCause } from "../../src/internal/effect-failures.js"

class InternalFailure {
    constructor(readonly id: number) {}
}

class PublicFailure {
    constructor(readonly source: InternalFailure) {}
}

class Trace extends Context.Service<Trace, string>()("test/Trace") {}

const toPublic = (failure: InternalFailure) => new PublicFailure(failure)
const internal = failures(InternalFailure)

const failureOf = async <A, E>(effect: Effect.Effect<A, E>) => {
    const exit = await Effect.runPromiseExit(effect)
    if (!Exit.isFailure(exit)) throw new Error("Expected a failure")
    return exit.cause
}

describe("mapCause", () => {
    test("maps a failure Effect turned into a defect, keeping its annotations and the reason order", () => {
        const cleanup = new Error("cleanup")
        const converted = Cause.annotate(Cause.die(new InternalFailure(1)), Context.make(Trace, "converted"))
        const cause = Cause.fromReasons([
            ...Cause.die(cleanup).reasons,
            ...converted.reasons,
            ...Cause.interrupt(7).reasons,
        ]) as Cause.Cause<InternalFailure>

        const mapped = mapCause(cause, internal, toPublic)

        expect(mapped.reasons.map((reason) => reason._tag)).toEqual(["Die", "Die", "Interrupt"])
        const [first, second, third] = mapped.reasons
        expect(first?._tag === "Die" && first.defect).toBe(cleanup)
        expect(second?._tag === "Die" && second.defect).toBeInstanceOf(PublicFailure)
        expect(Context.getOrUndefined(Cause.reasonAnnotations(second!), Trace)).toBe("converted")
        expect(third?._tag === "Interrupt" && third.fiberId).toBe(7)
    })

    test("leaves a genuine defect of a class the matcher does not list unchanged", () => {
        const defect = new Error("fault")
        const cause = Cause.fromReasons([
            ...Cause.die(defect).reasons,
            ...Cause.die(new InternalFailure(2)).reasons,
        ]) as Cause.Cause<InternalFailure>

        const [first, second] = mapCause(cause, internal, toPublic).reasons

        expect(first?._tag === "Die" && first.defect).toBe(defect)
        expect(second?._tag === "Die" && second.defect).toBeInstanceOf(PublicFailure)
    })

    test("leaves an application-marked defect unchanged even when its class matches", () => {
        const raised = new InternalFailure(3)
        const cause = inputDefect(raised) as Cause.Cause<InternalFailure>

        const [reason] = mapCause(cause, internal, toPublic).reasons

        expect(reason?._tag === "Die" && reason.defect).toBe(raised)
        expect(applicationMarked(reason!)).toBe(true)
    })

    test("keeps converted failures as raised with keepConvertedFailures", () => {
        const raised = new InternalFailure(4)
        const cause = Cause.fromReasons([...Cause.die(raised).reasons, ...Cause.die(new Error("x")).reasons])

        const [reason] = mapCause(cause, keepConvertedFailures, () => "mapped").reasons

        expect(reason?._tag === "Die" && reason.defect).toBe(raised)
    })
})

describe("mapFailureCause", () => {
    test("maps a typed failure without a defect normally", async () => {
        const cause = await failureOf(Effect.fail(new InternalFailure(5)).pipe(mapFailureCause(internal, toPublic)))

        expect(cause.reasons).toHaveLength(1)
        const [reason] = cause.reasons
        expect(reason?._tag).toBe("Fail")
        expect(reason?._tag === "Fail" && reason.error.source.id).toBe(5)
    })

    test("maps a typed failure that Effect turned into a defect beside a cleanup defect", async () => {
        const cleanup = new Error("cleanup")
        const cause = await failureOf(
            Effect.fail(new InternalFailure(6)).pipe(
                Effect.ensuring(Effect.die(cleanup)),
                mapFailureCause(internal, toPublic),
            ),
        )

        const defects = cause.reasons.map((reason) => (reason._tag === "Die" ? reason.defect : reason._tag))
        expect(defects).toHaveLength(2)
        expect(defects[0]).toBeInstanceOf(PublicFailure)
        expect(defects[1]).toBe(cleanup)
        expect(defects.some((defect) => defect instanceof InternalFailure)).toBe(false)
    })

    test("keeps interruption beside the mapped failure", async () => {
        const cause = await failureOf(
            Effect.failCause(
                Cause.fromReasons<InternalFailure>([
                    ...Cause.fail(new InternalFailure(8)).reasons,
                    ...Cause.interrupt(9).reasons,
                ]),
            ).pipe(mapFailureCause(internal, toPublic)),
        )

        expect(cause.reasons.map((reason) => reason._tag)).toEqual(["Fail", "Interrupt"])
        expect(Cause.hasInterrupts(cause)).toBe(true)
    })
})
