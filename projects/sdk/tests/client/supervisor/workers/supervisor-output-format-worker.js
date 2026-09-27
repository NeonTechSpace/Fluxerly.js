// Reports the log format it received, writes each kind of output line, then a large final stderr burst, and exits
// before joining the supervisor protocol. exitCode lets Node flush the pipes, so any lost line is the parent's fault
console.log(`format=${process.env.FLUXERLY_LOG_FORMAT} color=${process.env.FLUXERLY_LOG_COLOR}`)
console.log(
    JSON.stringify({
        time: "2026-01-01T00:00:00.000Z",
        level: "info",
        category: "lifecycle",
        code: "lifecycle.fixture",
        message: "child record",
        fields: { shards: 1 },
    }),
)
console.log(JSON.stringify({ application: "own json" }))
console.log(`long:${"x".repeat(300_000)}`)
const frames = Array.from({ length: 4_000 }, (_, index) => `    at frame${index} (fixture.js:${index}:1)`)
console.error(`Error: final crash\n${frames.join("\n")}\nlast stack line`)
process.exitCode = 3
