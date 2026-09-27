import { afterEach, expect, test, vi } from "vitest"
import { modes, setup as setupClient, type Mode } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { settle } from "../../support/settle.js"

afterEach(() => vi.unstubAllGlobals())

const setup = (mode: Mode) => setupClient(mode, { token: "fixture_only", cache: { guilds: true, channels: true } })

test.each(modes)("%s invalidates channels and pending reads when a settings patch may sanitize names", async (mode) => {
    const client = await setup(mode)
    const channel = { id: "100", guild_id: "200", type: 0, name: "Flexible Name" }
    const guild = { id: "200", owner_id: "300", name: "Guild", features: [] }
    let hold = false,
        release!: () => void,
        started!: () => void
    const ready = new Promise<void>((resolve) => {
        started = resolve
    })
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        if (init.method === "GET") {
            if (hold) {
                started()
                await held
            }
            return Response.json(url.endsWith("/channels/100") ? channel : guild)
        }
        throw Error("Discarded settings response")
    })
    await settle(client.channels.fetch("100"))
    await settle(client.guilds.fetch("200"))
    hold = true
    const pending = settle(client.channels.fetch("100"))
    await ready
    try {
        await expect(settle(client.guilds.edit("200", { featureToggles: [] }))).rejects.toMatchObject({
            outcome: "unknown",
        })
        const local = client.channels.get("100")
        expect(await settle(local)).toBeUndefined()
    } finally {
        release()
    }
    await pending
    const after = client.channels.get("100")
    expect(await settle(after)).toBeUndefined()
})

test.each(modes)(
    "%s leaves channel observations alone for a server rename or retained flexible names",
    async (mode) => {
        const client = await setup(mode)
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) =>
            Response.json(
                init.method === "GET"
                    ? { id: "100", guild_id: "200", type: 0, name: "Flexible Name" }
                    : { id: "200", owner_id: "300", name: "Renamed", features: ["TEXT_CHANNEL_FLEXIBLE_NAMES"] },
            ),
        )
        await settle(client.channels.fetch("100"))
        await settle(client.guilds.edit("200", { name: "Renamed" }))
        await settle(client.guilds.edit("200", { featureToggles: ["TEXT_CHANNEL_FLEXIBLE_NAMES"] }))
        const local = client.channels.get("100")
        expect(await settle(local)).toMatchObject({
            name: "Flexible Name",
        })
    },
)
