import { expect, test } from "vitest"
import { runIdentityValue, runVerifiedBotId } from "./support/harness.js"

const sandbox = { token: "synthetic-token-value", applicationId: "111111111111111111", guildId: "222222222222222222" }
const botId = "333333333333333333"

// Catches: A harness that skipped its identity reads on a value from another run, another env file or a hand-set
// environment variable, so it could act on a server nobody verified
test("a run identity counts only for the runner that verified this exact sandbox env", () => {
    const value = runIdentityValue(botId, sandbox, 4242)
    expect(runVerifiedBotId(sandbox, { value, parent: 4242 })).toBe(botId)
    // The value holds no credential
    expect(value).not.toContain(sandbox.token)
    // Another parent process, token, application or server does not count
    expect(runVerifiedBotId(sandbox, { value, parent: 4243 })).toBeUndefined()
    for (const changed of [
        { ...sandbox, token: "other-synthetic-token" },
        { ...sandbox, applicationId: "111111111111111112" },
        { ...sandbox, guildId: "222222222222222223" },
    ])
        expect(runVerifiedBotId(changed, { value, parent: 4242 })).toBeUndefined()
    // A changed bot ID or digest, a missing value and malformed values do not count
    const [runner, , key, mac] = value.split(":")
    expect(
        runVerifiedBotId(sandbox, { value: [runner, "444444444444444444", key, mac].join(":"), parent: 4242 }),
    ).toBeUndefined()
    expect(
        runVerifiedBotId(sandbox, { value: [runner, botId, key, `${mac}A`].join(":"), parent: 4242 }),
    ).toBeUndefined()
    for (const malformed of [undefined, "", "4242", `${value}:extra`])
        expect(runVerifiedBotId(sandbox, { value: malformed, parent: 4242 })).toBeUndefined()
})
