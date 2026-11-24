/*
 * Deterministic expect-test matrix for gateway close-code classification.
 * Captures classifyClose(code, resuming) and closeCodeInfo(code) across every recognized WebSocket and
 * Fluxer close code, every code in 4000..4014 and representative unknown codes, stored in a reviewable snapshot fixture
 */
import { expect, test } from "vitest"
import { classifyClose } from "../../src/internal/gateway/session.js"
import { closeCodeInfo } from "../../src/internal/protocol/gateway.js"

const codes: readonly number[] = [
    1000,
    1001,
    1002,
    1006,
    1007,
    1008,
    1009,
    1011,
    3000,
    ...Array.from({ length: 15 }, (_, index) => 4000 + index),
    4999,
]

function pad(value: string, width: number): string {
    return value.padEnd(width, " ")
}

function renderMatrix(): string {
    const headers = [
        "code",
        "resuming",
        "name",
        "action",
        "retry",
        "resetSession",
        "end",
        "errorTag",
        "errorReason",
        "status",
    ] as const
    const rows: string[][] = []
    for (const code of codes) {
        const info = closeCodeInfo(code)
        for (const resuming of [false, true]) {
            const classified = classifyClose(code, resuming)
            const failure = classified.failure
            const reason = "reason" in failure ? String(failure.reason) : "-"
            const status = "status" in failure ? String(failure.status) : "-"
            rows.push([
                String(code),
                String(resuming),
                info.name,
                info.action,
                String(classified.retry),
                String(classified.resetSession),
                classified.end,
                failure._tag,
                reason,
                status,
            ])
        }
    }
    const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]!.length)))
    const format = (cells: readonly string[]) =>
        cells.map((cell, column) => (column === cells.length - 1 ? cell : pad(cell, widths[column]!))).join(" | ")
    const divider = widths.map((width) => "-".repeat(width)).join("-+-")
    return [format(headers), divider, ...rows.map(format)].join("\n") + "\n"
}

test("gateway close-code classification matrix matches snapshot", async () => {
    await expect(renderMatrix()).toMatchFileSnapshot("./gateway-close-matrix.snapshot.txt")
})
