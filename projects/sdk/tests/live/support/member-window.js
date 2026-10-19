// The measured window of the message-members check. A new session sends the guild again with the bot's own member,
// which refills the member cache with no message intake at all. The guard records a guild snapshot (a guildCreate
// event or a store of the guild in the guild cache) or a shard session change between the cache removal and the
// accepted store, so such a run fails as inconclusive instead of passing for the wrong reason. It also reports
// whether the startup snapshot has been delivered, which the check awaits before opening the window

export const inconclusiveMessage = "A reconnect or guild snapshot happened during the check, rerun it"

/** Thrown when the window saw a reconnect or guild snapshot. The message names no sandbox data */
export class InconclusiveWindow extends Error {
    constructor() {
        super(inconclusiveMessage)
        this.name = "InconclusiveWindow"
    }
}

/** A guard for one sandbox guild. Events and cache changes of other guilds are not this check's concern */
export function createWindowGuard(guildId) {
    let baseline
    let snapshots = 0
    let started = false
    return {
        /** Whether the sandbox guild's startup guildCreate has been delivered */
        get started() {
            return started
        },
        /** Starts the window with every shard's current session epoch */
        open(epochs) {
            baseline = epochs.join(",")
            snapshots = 0
        },
        /** Ends the window, so later snapshots no longer count */
        close() {
            baseline = undefined
        },
        /** Records one guildCreate event, which counts as a snapshot only for the sandbox guild inside the window */
        guildCreate(id) {
            if (id !== guildId) return
            started = true
            if (baseline !== undefined) snapshots++
        },
        /** Records one cache change, where only a store of the sandbox guild inside the window counts as a snapshot */
        change(change) {
            if (baseline !== undefined && change.kind === "guilds" && change.op === "set" && change.key === guildId)
                snapshots++
        },
        /** Throws when the window saw a snapshot or any shard's session epoch differs from the start */
        check(epochs) {
            if (baseline !== undefined && (snapshots > 0 || epochs.join(",") !== baseline))
                throw new InconclusiveWindow()
        },
    }
}
