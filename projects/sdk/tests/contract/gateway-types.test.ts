import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

// scripts/gateway-types.js renders the raw gateway event's types and the runtime list of documented dispatch types from
// the committed gateway documentation fixture and overlay, with the reviewed corrections of scripts/gateway-types-corrections.json
// applied and stamped into the files. A fixture regenerated at a new pin, an edited generator or edited corrections must
// come with regenerated files, so the raw event's documented flag and its types never describe different pins
interface Generator {
    readonly payloadsPath: string
    readonly namesPath: string
    readGatewayTypeSources(): Promise<unknown>
    renderGatewayTypes(sources: unknown): Promise<{ readonly payloads: string; readonly names: string }>
}

test("the generated gateway payload types and documented dispatch list match the fixture", async () => {
    const generator = (await import(new URL("../../scripts/gateway-types.js", import.meta.url).href)) as Generator
    const rendered = await generator.renderGatewayTypes(await generator.readGatewayTypeSources())
    const stale = [
        readFileSync(generator.payloadsPath, "utf8") === rendered.payloads ? [] : ["src/gateway-payloads.ts"],
        readFileSync(generator.namesPath, "utf8") === rendered.names
            ? []
            : ["src/internal/gateway/documented-dispatches.ts"],
    ].flat()
    expect(stale, "Run node sdk/scripts/gateway-types.js from projects/ and review the diff").toEqual([])
})

// The corrections fail closed, so a Fluxer fix or a moved pin that makes one wrong or unneeded stops generation
test("a gateway correction that names something missing, changes nothing or lacks evidence fails rendering", async () => {
    const generator = (await import(new URL("../../scripts/gateway-types.js", import.meta.url).href)) as Generator
    const sources = (await generator.readGatewayTypeSources()) as {
        fixture: { events: Record<string, unknown> }
        corrections: {
            objects: { object: string; optional?: string[]; evidence: string[]; reason: string }[]
            newEvents: { event: string }[]
        }
    }
    const withCorrections = (change: (corrections: typeof sources.corrections) => void) => {
        const corrections = structuredClone(sources.corrections)
        change(corrections)
        return generator.renderGatewayTypes({ ...sources, corrections })
    }
    const options = (corrections: typeof sources.corrections) =>
        corrections.objects.find((entry) => entry.object.endsWith("#audit-log-options-object"))!
    await expect(withCorrections((c) => (options(c).optional = ["not_a_field"]))).rejects.toThrow()
    await expect(withCorrections((c) => (options(c).evidence = []))).rejects.toThrow()
    await expect(withCorrections((c) => (options(c).evidence = ["somewhere without a line"]))).rejects.toThrow()
    await expect(withCorrections((c) => c.objects.push({ ...options(c), object: "not-an-object" }))).rejects.toThrow()
    // Making a field optional twice changes nothing the second time
    await expect(withCorrections((c) => c.objects.push(structuredClone(options(c))))).rejects.toThrow()
    // An event Fluxer's documents now describe needs no added event
    await expect(
        generator.renderGatewayTypes({
            ...sources,
            fixture: { ...sources.fixture, events: { ...sources.fixture.events, GUILD_HEALTH_UPDATE: {} } },
        }),
    ).rejects.toThrow()
})
