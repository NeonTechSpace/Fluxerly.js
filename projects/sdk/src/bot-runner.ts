import type { OperationSignal } from "./client.js"
import { FluxerlyError } from "./errors.js"

/**
 * Configure how runBot stops. Importing the SDK does not register process signal handlers, only a running bot does
 *
 * @category Options
 */
export interface RunBotOptions {
    /** Stop and close the bot when this signal aborts, as a normal stop. If already aborted, the configuration is still
     * checked and misuse is still reported, but no client is created and the run succeeds at once
     */
    readonly signal?: OperationSignal
    /** Handle SIGINT and SIGTERM for this run only, as a requested stop that drains for drainMs. The handlers are added
     * when the run starts and removed once its cleanup finishes, and the runner never exits the process.
     * The default API enables this unless the option is false. The Effect API enables it only when the option is true,
     * because a launcher such as NodeRuntime.runMain already interrupts the program on these signals.
     * Each signal is handled once, so sending the same signal again, such as a second Ctrl+C, ends the process at once
     * with Node.js's default behavior instead of waiting for the drain
     */
    readonly processSignals?: boolean
    /**
     * Milliseconds that a requested stop lets running work finish before cancelling it, default 5,000.
     * A stop is requested by the signal option or, with processSignals enabled, by SIGINT or SIGTERM.
     * The bot then accepts no new events, while running handlers and commands, events already waiting for them and REST
     * requests continue until they finish or the time runs out. Then the bot shuts down as usual.
     * The default fits within the 10 seconds that common process managers, such as Docker, wait before force-stopping
     * a process. Pass a larger value when the platform waits longer, or 0 to cancel running handlers at once.
     * A stop caused by a failure does not drain. See ShutdownOptions for the details of a drain.
     * Accepts an integer from 0 through 2,147,483,647, and another value throws ConfigurationError
     */
    readonly drainMs?: number
    /**
     * Report a failed run for the process, enabled by default. When the bot stops because of a failure, runBot logs that
     * failure once as an Error record with code lifecycle.botFailed, unless the client already logged the same error, and
     * sets `process.exitCode` to 1 so the process exits with a failure status. The failure is still returned as well.
     * Reports before client creation use the configured logging settings and mask the token after removing surrounding
     * whitespace and one pair of matching quotes. Unusable logging settings fall back to the entry point's default output.
     * In the native API, a throwing option getter does not discard readable token, logging or reportFailure settings.
     * An unreadable reportFailure setting keeps reporting enabled. Default API misuse and option-getter failures throw
     * synchronously without a runner report or exit-status change.
     * A normal stop and an interruption report nothing. Set false when the application handles the returned failure and
     * owns the exit status itself
     */
    readonly reportFailure?: boolean
}

/**
 * One of the bot's event or command subscriptions ended normally while its client was still running
 *
 * @category Errors
 */
export class CriticalWorkerStoppedError extends FluxerlyError {
    /** Discriminator for a critical subscription that ended while the bot was running */
    readonly _tag = "CriticalWorkerStoppedError"

    constructor(
        /** Zero-based index among the bot's subscriptions: Its event handlers in configuration order, then its command router */
        readonly workerIndex: number,
    ) {
        super(`Bot subscription ${workerIndex + 1} ended while the bot was still running, so the bot stopped`, {
            code: "bot.workerStopped",
            hint: "Subscriptions are numbered from 1 in the order of the events option, then the command router. Keep the bot's subscriptions open while it runs",
            details: { workerIndex },
        })
        this.name = "CriticalWorkerStoppedError"
    }
}
