import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import { GuildOperationError, type Client as DefaultClient, type GuildMember } from "../../../src/index.js"
import { createClient as createNative, type Client as NativeClient } from "../../../src/effect.js"
import { fixtureToken, modes, setup } from "../../support/both-apis.js"

const until = "2026-10-01T12:00:00.000Z"
const at = (iso: string) => new Date(iso)
const member = (communicationDisabledUntil?: string | null) =>
    ({ communicationDisabledUntil }) as Pick<GuildMember, "communicationDisabledUntil">

test.each(modes)(
    "%s timeoutState reports none, active or unknown, ending a timeout at its exact expiry",
    async (mode) => {
        const client = await setup(mode)
        const state = (value: Pick<GuildMember, "communicationDisabledUntil">, now: string) =>
            client.members.timeoutState(value, { now: at(now) })
        expect(state(member(until), "2026-10-01T11:59:59.999Z")).toBe("active")
        // A timeout that ends at the moment is over, so the boundary is none
        expect(state(member(until), until)).toBe("none")
        expect(state(member(until), "2026-10-01T12:00:00.001Z")).toBe("none")
        expect(state(member(null), until)).toBe("none")
        // An offset names the same moment as UTC
        expect(state(member("2026-10-01T14:00:00+02:00"), "2026-10-01T11:59:59Z")).toBe("active")
        // A snapshot without the field says nothing, which differs from no timeout
        expect(state(member(), until)).toBe("unknown")
        expect(state({} as never, until)).toBe("unknown")
    },
)

test.each(modes)("%s timeoutState reads the client's current time when none is supplied", async (mode) => {
    const client = await setup(mode)
    const soon = new Date(Date.now() + 3_600_000).toISOString()
    const earlier = new Date(Date.now() - 3_600_000).toISOString()
    expect(client.members.timeoutState(member(soon))).toBe("active")
    expect(client.members.timeoutState(member(earlier))).toBe("none")
    expect(client.members.timeoutState(member(earlier), {})).toBe("none")
})

test("native timeoutState reads the wall time of the Clock the client was created with", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const creationClock = yield* TestClock.make({ warningDelay: "10 seconds" })
                const otherClock = yield* TestClock.make({ warningDelay: "10 seconds" })
                const client = yield* createNative({ token: fixtureToken }).pipe(
                    Effect.provideService(Clock.Clock, creationClock),
                )
                yield* creationClock.setTime(Date.parse("2026-10-01T11:59:59.999Z"))
                yield* otherClock.setTime(Date.parse("2026-12-01T00:00:00Z"))
                // The Clock that is current at the call does not matter, only the one the client was created with
                const stateAt = () =>
                    Effect.sync(() => client.members.timeoutState(member(until))).pipe(
                        Effect.provideService(Clock.Clock, otherClock),
                    )
                expect(yield* stateAt()).toBe("active")
                yield* creationClock.adjust(1)
                expect(yield* stateAt()).toBe("none")
                // An explicit moment still wins over the client's Clock
                expect(client.members.timeoutState(member(until), { now: at("2026-10-01T00:00:00Z") })).toBe("active")
            }),
        ),
    )
})

test.each(modes)("%s timeoutState treats malformed input as misuse", async (mode) => {
    const client = await setup(mode)
    const bad: [unknown, unknown, string][] = [
        [undefined, undefined, "member"],
        [null, undefined, "member"],
        ["2026-10-01T12:00:00Z", undefined, "member"],
        [member(5 as never), undefined, "member.communicationDisabledUntil"],
        [member("tomorrow"), undefined, "member.communicationDisabledUntil"],
        [member("2026-02-30T12:00:00Z"), undefined, "member.communicationDisabledUntil"],
        [member(until), { now: new Date("invalid") }, "options.now"],
        [member(until), { now: Date.now() }, "options.now"],
        [member(until), "now", "options"],
        [member(until), { nov: at(until) }, "options"],
    ]
    for (const [value, options, path] of bad) {
        let thrown: unknown
        try {
            client.members.timeoutState(value as never, options as never)
        } catch (error) {
            thrown = error
        }
        expect(thrown).toBeInstanceOf(GuildOperationError)
        expect(thrown).toMatchObject({
            operation: "members.timeoutState",
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path },
        })
    }
})

test.each(modes)("%s timeoutState still answers after the client shut down", async (mode) => {
    const client = await setup(mode)
    if (mode === "default") await (client as DefaultClient).shutdown()
    else await Effect.runPromise((client as NativeClient).shutdown())
    expect(client.members.timeoutState(member(until), { now: at("2026-10-01T00:00:00Z") })).toBe("active")
})
