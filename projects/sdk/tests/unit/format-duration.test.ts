import { expect, test } from "vitest"
import { formatDuration } from "../../src/internal/client/lifetime.js"

test.each([
    [0, "0 ms"],
    [999.4, "999 ms"],
    [999.5, "1.0 s"],
    [1_000, "1.0 s"],
    [59_949, "59.9 s"],
    [59_950, "1 min 0 s"],
    [59_999, "1 min 0 s"],
    [60_000, "1 min 0 s"],
    [119_499, "1 min 59 s"],
    [119_600, "2 min 0 s"],
    [3_600_000, "60 min 0 s"],
])("formats %d ms as %s without a 60 in the seconds or 1000 in the milliseconds", (milliseconds, text) => {
    expect(formatDuration(milliseconds)).toBe(text)
})
