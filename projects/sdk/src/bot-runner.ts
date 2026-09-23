import type { OperationSignal } from "./client.js"

/** Configure the optional bot runner. Importing the SDK does not register process signal handlers */
export interface RunBotOptions {
    /** Stop and close the bot when this signal aborts. If already aborted, do not create a client */
    readonly signal?: OperationSignal
    /** Handle SIGINT and SIGTERM for this run only. Disabled by default, with handlers removed on completion */
    readonly processSignals?: boolean
}

/** A critical subscription ended normally while the bot's client was still running */
export class CriticalWorkerStoppedError extends Error {
    readonly _tag = "CriticalWorkerStoppedError"

    constructor(/** Zero-based index in the subscriptions returned by install */ readonly workerIndex: number) {
        super(`Critical subscription ${workerIndex + 1} stopped before the bot`)
        this.name = "CriticalWorkerStoppedError"
    }
}
