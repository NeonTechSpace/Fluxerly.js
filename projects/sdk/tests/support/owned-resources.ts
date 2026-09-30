import { AsyncLocalStorage, createHook } from "node:async_hooks"
import { setImmediate as turn } from "node:timers/promises"
import { onTestFinished } from "vitest"

/** Track referenced SDK resource identities, not the runner's process-wide resource counts */
export function ownedResources() {
    const owner = new AsyncLocalStorage<boolean>()
    const resources = new Map<number, { kind: string; resource: { hasRef?: () => boolean } }>()
    const kinds = new Set(["Timeout", "TCPWRAP", "TCPCONNECTWRAP", "TLSWRAP", "UDPWRAP"])
    const hook = createHook({
        init(id, kind, _trigger, resource) {
            if (owner.getStore() && kinds.has(kind)) resources.set(id, { kind, resource })
        },
        destroy(id) {
            resources.delete(id)
        },
    }).enable()
    onTestFinished(() => {
        hook.disable()
        owner.disable()
    })
    const remaining = () =>
        [...resources.values()].filter(({ resource }) => resource.hasRef?.() !== false).map(({ kind }) => kind)
    return {
        run: <T>(work: () => T): T => owner.run(true, work),
        remaining,
        /** Destruction notifications drain on turns. The test runner's watchdog bounds a leaked resource */
        async released() {
            while (remaining().length > 0) await turn()
        },
    }
}
