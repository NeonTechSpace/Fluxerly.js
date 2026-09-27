import type { Client, ClientDiagnostics } from "@neontechspace/fluxerly"
import type { Client as NativeClient } from "@neontechspace/fluxerly/effect"

export function eventOccupancy(client: Client | NativeClient): ClientDiagnostics["events"] {
    const report = client.diagnostics()
    const counts: readonly number[] = [
        report.events.subscriptions,
        report.events.messageCollectors,
        report.events.reactionCollectors,
        report.events.activeHandlers,
    ]
    void counts
    return report.events
}
