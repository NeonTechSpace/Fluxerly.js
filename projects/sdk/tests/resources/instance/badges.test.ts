import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { expectErr, settle } from "../../support/settle.js"

// Fluxer 5f3fc0b1: InstanceController serves GET /instance/badges by comma-separated ids or by after and limit, and
// answers { version, badges: [{ id, name, description, asset_url, href, position }], next }
async function open(mode: Mode) {
    if (mode === "default") {
        const test = createDefaultTestClient()
        onTestFinished(() => test.shutdown())
        return test
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope)))
}

const badge = (id: string, position: string) => ({
    id,
    name: `Badge ${id}`,
    description: null,
    asset_url: `https://media.example/badges/${id}.webp`,
    href: id === "1" ? "https://example.com" : null,
    position,
})

test.each(modes)("%s looks up community badges by ID", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("GET /instance/badges", {
        body: { version: "v3", badges: [badge("1", "-5"), badge("2", "10")], next: null },
    })

    const page = await settle(api.client.instance.fetchBadges({ ids: ["1", "2", "3"] }))
    expect(page).toEqual({
        version: "v3",
        badges: [
            {
                id: "1",
                name: "Badge 1",
                description: null,
                assetUrl: "https://media.example/badges/1.webp",
                href: "https://example.com",
                position: "-5",
            },
            {
                id: "2",
                name: "Badge 2",
                description: null,
                assetUrl: "https://media.example/badges/2.webp",
                href: null,
                position: "10",
            },
        ],
        nextAfter: null,
    })
    expect(Object.isFrozen(page) && Object.isFrozen(page.badges) && page.badges.every(Object.isFrozen)).toBe(true)
    expect(route.requests()[0]!.query).toEqual({ ids: "1,2,3" })
})

test.each(modes)("%s pages through every community badge", async (mode) => {
    const api = await open(mode)
    const route = api.rest.respond("GET /instance/badges", {
        body: { version: "v3", badges: [badge("4", "1")], next: "g1" },
    })

    expect(await settle(api.client.instance.fetchBadges())).toMatchObject({ nextAfter: "g1" })
    expect(await settle(api.client.instance.fetchBadges({ after: "g1", limit: 1 }))).toMatchObject({
        badges: [{ id: "4" }],
    })
    expect(route.requests().map((request) => request.query)).toEqual([{}, { after: "g1", limit: "1" }])
})

test.each(modes)("%s rejects a page longer than the limit", async (mode) => {
    const api = await open(mode)
    api.rest.respond("GET /instance/badges", {
        body: { version: "v3", badges: [badge("4", "1"), badge("5", "2")], next: null },
    })
    expect(await expectErr(api.client.instance.fetchBadges({ limit: 1 }))).toMatchObject({
        _tag: "GuildOperationError",
        operation: "instance.fetchBadges",
        reason: "response",
    })
})

test.each(modes)("%s checks badge queries before sending", async (mode) => {
    const api = await open(mode)
    const queries = [
        { ids: [] },
        { ids: ["1"], limit: 5 },
        { ids: ["badge"] },
        { limit: 201 },
        { after: "" },
        { id: "1" },
    ]
    for (const query of queries)
        expect(await expectErr(api.client.instance.fetchBadges(query as never))).toMatchObject({
            operation: "instance.fetchBadges",
            reason: "input",
            outcome: "notDispatched",
        })
    expect(api.requests()).toEqual([])
})

// Catches: A validation entry without a code was dropped, so an invalid cursor left an empty validationErrors list
test.each(modes)("%s keeps the field Fluxer rejects without a code", async (mode) => {
    const api = await open(mode)
    api.rest.respond("GET /instance/badges", {
        status: 400,
        body: { code: "INVALID_FORM_BODY", message: "Invalid", errors: [{ path: "after", message: "x" }] },
    })
    const error = await expectErr(api.client.instance.fetchBadges({ after: "not-a-cursor" }))
    expect(error).toMatchObject({ operation: "instance.fetchBadges", reason: "rejected" })
    const apiError = (error as { readonly apiError?: { readonly validationErrors?: readonly unknown[] } }).apiError
    expect(apiError?.validationErrors).toEqual([{ providerCode: "", explanation: expect.any(String), path: "after" }])
    expect((error as Error).message).toContain("Field after")
})
