import { Effect, Redacted } from "effect"
import { runGateway } from "../dist/internal/gateway.js"

export async function runFixtureGateway(bridge, assignment, delayMs = 0) {
    const gatewayUrl = process.env.FLUXERLY_SUPERVISOR_GATEWAY
    if (typeof gatewayUrl !== "string") throw new Error("Missing fixture gateway URL")
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    const shardId = assignment.shardIds[0]
    if (shardId === undefined) throw new Error("Missing fixture shard assignment")
    const worker = Effect.scoped(
        Effect.raceFirst(
            runGateway(
                gatewayUrl,
                Redacted.make("fixture-only"),
                { id: undefined, sequence: null },
                2_000,
                () => {},
                () => {},
                () => {},
                () => {},
                undefined,
                undefined,
                undefined,
                undefined,
                [shardId, assignment.totalShards],
                (send) => bridge.identifyGate.permit(shardId, send),
            ),
            bridge.waitForStop(),
        ),
    )
    const exit = await Effect.runPromiseExit(worker)
    if (exit._tag === "Failure") throw new Error("Fixture gateway failed")
}
