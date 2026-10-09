import { Effect, Redacted } from "effect"
import { runGateway } from "../../../../dist/internal/gateway.js"

export async function runFixtureGateway(bridge, assignment, delayMs = 0) {
    const gatewayUrl = process.env.FLUXERLY_SUPERVISOR_GATEWAY
    if (typeof gatewayUrl !== "string") throw new Error("Missing fixture gateway URL")
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    const shardId = assignment.shardIds[0]
    if (shardId === undefined) throw new Error("Missing fixture shard assignment")
    const worker = Effect.scoped(
        Effect.raceFirst(
            runGateway({
                url: gatewayUrl,
                token: Redacted.make("fixture-only"),
                session: { id: undefined, sequence: null },
                timeoutMs: 30_000,
                onReady: () => {},
                onLatency: () => {},
                onRecovering: () => {},
                onDispatch: () => {},
                shard: [shardId, assignment.totalShards],
                identify: (send) => bridge.identifyGate.permit(shardId, send),
            }),
            bridge.waitForStop(),
        ),
    )
    const exit = await Effect.runPromiseExit(worker)
    if (exit._tag === "Failure") throw new Error("Fixture gateway failed")
}
