// Writes two warn records as a child logging JSON would, one carrying an expected SDK error with a cause and one
// carrying an application error, then exits before joining the supervisor protocol
const stack = (name) => `${name}: failed\n    at handler (/app/fixture.js:10:5)\n    at run (/app/fixture.js:20:5)`
const record = (code, message, error) =>
    JSON.stringify({ time: "2026-01-01T00:00:00.000Z", level: "warn", category: "application", code, message, error })
console.log(
    record("application.callbackFailed", "sdk error record", {
        origin: "sdk",
        name: "GuildOperationError",
        message: "Guild rejected",
        code: "guild.rejected",
        stack: stack("GuildOperationError"),
        cause: {
            origin: "sdk",
            name: "RestError",
            message: "Rejected",
            code: "rest.rejected",
            stack: stack("RestError"),
        },
    }),
)
console.log(
    record("application.callbackFailed", "application error record", {
        origin: "application",
        name: "TypeError",
        message: "bad input",
        stack: stack("TypeError"),
    }),
)
process.exitCode = 3
