import { spawnSync } from "node:child_process"
import { expect, test } from "vitest"
import { liveChecks } from "./run-all.js"
import { categories, categoriesForChanges, selectionUnits } from "./support/categories.js"
import { declaredCheck } from "./support/check-classes.js"

const checks = liveChecks()
const sdkWork = [...checks.values()].filter((check) => check.sdkWork)
const select = (...paths) => categoriesForChanges(paths, checks).categories

test("every SDK-work check and both of its modes belong to some category", () => {
    const covered = new Set()
    for (const members of Object.values(categories))
        for (const member of members) {
            const [name, mode] = member.split("@")
            expect(checks.get(name)?.sdkWork, member).toBe(true)
            for (const command of checks.get(name).commands)
                if (mode === undefined || command.args[0] === mode) covered.add(`${name}@${command.args[0]}`)
        }
    for (const check of sdkWork)
        for (const command of check.commands)
            expect(covered, `${check.name} ${command.args[0]}`).toContain(`${check.name}@${command.args[0]}`)
})

test("a category runs its checks, and both halves of a check that cannot run its modes at once run as one check", () => {
    expect(selectionUnits(["smoke"], checks).map((check) => check.name)).toEqual(categories.smoke)
    expect(selectionUnits(["reactions"], checks).map((check) => [check.name, check.commands.length])).toEqual([
        ["reactions@default", 1],
    ])
    // Both halves together never share a lock: they become the whole check, its modes one after the other
    expect(selectionUnits(["reactions", "reactions-effect"], checks).map((check) => check.name)).toEqual(["reactions"])
    expect(selectionUnits(["cleanup-effect", "cleanup"], checks).map((check) => check.name)).toEqual(["cleanup"])
    // recovery-window runs both modes at once under one lock per mode
    const window = selectionUnits(["recovery-window"], checks)
    expect(window.map((check) => check.name)).toEqual(["recovery-window@default", "recovery-window@effect"])
    const keys = window.map((check) => declaredCheck(check.commands[0].harness, check.commands[0].args).key)
    expect(new Set(keys).size).toBe(2)
    expect(() => selectionUnits(["no-such-category"], checks)).toThrow(/Unknown live category or check/)
    expect(() => selectionUnits(["presence"], checks)).toThrow(/per-run authorization/)
})

test("changed SDK source files select the categories of their area", () => {
    expect(select("projects/sdk/src/internal/reactions.ts")).toEqual(["reactions", "reactions-effect"])
    expect(select("projects/sdk/src/api/effect/emojis.ts")).toEqual(["expressions"])
    expect(select("projects/sdk/src/api/default/webhooks.ts")).toEqual(["threads", "webhooks"])
    expect(select("projects/sdk/src/internal/gateway/session.ts")).toEqual(["connection", "recovery"])
    // The REST owner also runs client.rest.call, so it selects the typed raw check beside rate limits
    expect(select("projects/sdk/src/internal/rest/owner.ts")).toEqual(["smoke", "rate-limits", "typed-raw"])
    // The route types, the call's public types and the typed raw event also run the live check that uses them
    expect(select("projects/sdk/src/rest-routes.ts")).toEqual(["smoke", "rate-limits", "typed-raw"])
    expect(select("projects/sdk/src/rest.ts")).toEqual(["smoke", "rate-limits", "typed-raw"])
    expect(select("projects/sdk/src/gateway-payloads.ts")).toEqual(["connection", "recovery", "typed-raw"])
    expect(select("projects/sdk/src/internal/gateway/documented-dispatches.ts")).toEqual([
        "connection",
        "recovery",
        "typed-raw",
    ])
    expect(select("projects/sdk/src/events.ts")).toEqual(["messages", "commands", "typed-raw"])
    // A source file no rule names runs the smoke category
    expect(select("projects/sdk/src/internal/binding/operations.ts")).toEqual(["smoke"])
})

test("changed live harness files select their checks' categories, and shared support selects smoke", () => {
    expect(select("projects/sdk/tests/live/expressions.js")).toEqual(["expressions"])
    expect(select("projects/sdk/tests/live/typed-raw.js")).toEqual(["typed-raw"])
    expect(select("projects/sdk/tests/live/recovery-window.js")).toEqual(["connection", "recovery-window"])
    expect(select("projects/sdk/tests/live/support/live-pacing.js")).toEqual(["smoke"])
    expect(select("projects/sdk/tests/live/messages.js")).toEqual(["smoke"])
    expect(select("projects/sdk/package.json")).toEqual(["smoke"])
})

test("attachment helpers select the upload scenario that executes them through the broad message harness", () => {
    expect(select("projects/sdk/tests/live/attachment-sources.mjs")).toEqual(["uploads"])
    expect(select("projects/sdk/tests/live/attachment-refresh.js")).toEqual(["uploads"])
})

// Catches: A documentation or website change that started live traffic, or a full suite chosen for routine work
test("documentation, website, release tooling and offline test changes select nothing live", () => {
    expect(
        select(
            "docs/README.md",
            "AGENTS.md",
            "projects/web/src/pages/index.astro",
            "projects/release/upstream.js",
            "projects/sdk/README.md",
            "projects/sdk/tests/live/README.md",
            "projects/sdk/tests/live/run-all.test.js",
            "projects/sdk/tests/resources/messages/messages.test.ts",
        ),
    ).toEqual([])
    expect(select(...sdkWork.map(() => "docs/README.md"))).toEqual([])
})

test("the runner refuses to run without a selection, so the full suite needs --full", () => {
    const child = spawnSync(process.execPath, [new URL("./run-all.js", import.meta.url).pathname], {
        encoding: "utf8",
        timeout: 30_000,
    })
    expect(child.status).toBe(1)
    expect(child.stderr).toContain("--full")
    expect(child.stderr).toContain("releases only")
})
