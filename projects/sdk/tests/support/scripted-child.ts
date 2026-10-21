import { EventEmitter } from "node:events"
import type { Mock } from "vitest"

export type ChildMessage = { readonly type: string; readonly [key: string]: unknown }

/**
 * A scripted child process: It says hello, finishes configuration when assigned and records every parent message.
 * It exits at once when asked to stop, unless holdShutdown is set, in which case the test calls exit and the child
 * keeps running as one that drains its work does. The test drives the rest of the protocol through emit or tell
 */
export function scriptedChild(pid: number, holdShutdown = false) {
    const received: ChildMessage[] = []
    const child = Object.assign(new EventEmitter(), {
        pid,
        connected: true,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        received,
        send(message: ChildMessage) {
            received.push(message)
            if (message.type === "assignment")
                queueMicrotask(() => child.emit("message", { type: "ready", generation: message.generation }))
            if (message.type === "shutdown" && !holdShutdown) child.exit(0)
            return true
        },
        kill() {
            child.exit(0)
            return true
        },
        exit(code: number) {
            if (!child.connected) return
            child.connected = false
            child.exitCode = code
            queueMicrotask(() => {
                child.emit("disconnect")
                child.emit("exit", code, null)
            })
        },
        /** Send a message to the parent. The parent answers synchronously, so the answer is the last one received */
        tell(message: ChildMessage) {
            child.emit("message", message)
            return received.at(-1)
        },
    })
    queueMicrotask(() => child.emit("message", { type: "hello" }))
    return child
}

export type ScriptedChild = ReturnType<typeof scriptedChild>

/** Fork scripted children in order, numbering their pids from firstPid. holdShutdown applies to all or selects by fork index */
export function forkScripted(
    fork: Mock,
    firstPid: number,
    holdShutdown: boolean | ((index: number) => boolean) = false,
) {
    const children: ScriptedChild[] = []
    fork.mockImplementation(() => {
        const hold = typeof holdShutdown === "function" ? holdShutdown(children.length) : holdShutdown
        const child = scriptedChild(firstPid + children.length, hold)
        children.push(child)
        return child
    })
    return children
}
