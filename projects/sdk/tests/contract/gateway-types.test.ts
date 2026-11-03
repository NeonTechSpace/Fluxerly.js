import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

// scripts/gateway-types.js renders the raw gateway event's types and the runtime list of documented dispatch types from
// the committed gateway documentation fixture and overlay. A fixture regenerated at a new pin, or an edited generator,
// must come with regenerated files, so the raw event's documented flag and its types never describe different pins
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
