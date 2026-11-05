import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

// The generated route types record one hash of the pin, the pinned docs files, the corrections and the generator, the
// way sdk/scripts/rest-routes.js computes it. Any of them changing without regenerating the file fails here
test("the generated REST route types match the upstream pin, the corrections and the generator", () => {
    const manifest = JSON.parse(read("../../../release/upstream/manifest.json"))
    const generated = read("../../src/rest-routes.ts")
    const expected = sha256(
        JSON.stringify({
            repository: manifest.repository,
            commit: manifest.commit,
            openapi: manifest.files.openapi,
            endpointDocs: manifest.endpointDocs ?? [],
            corrections: sha256(read("../../scripts/rest-routes-corrections.json").replaceAll("\r\n", "\n")),
            generator: sha256(read("../../scripts/rest-routes.js").replaceAll("\r\n", "\n")),
        }),
    )
    expect(
        /^\/\/ Inputs: ([0-9a-f]{64})$/m.exec(generated)?.[1],
        "Regenerate from projects/ with node sdk/scripts/rest-routes.js",
    ).toBe(expected)
    expect(generated).toContain(`${manifest.repository}@${manifest.commit}`)
})

// The schema corrections fail closed on a name the document lacks or a change that changes nothing
test("a REST schema correction that names something missing or changes nothing fails generation", async () => {
    const { restRoutesSource } = (await import(new URL("../../scripts/rest-routes.js", import.meta.url).href)) as {
        restRoutesSource(input: unknown): string
    }
    const schema = {
        type: "object",
        properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] }, kept: { type: "string" } },
    }
    const generate = (correction: Record<string, unknown>) => () =>
        restRoutesSource({
            spec: { openapi: "3.1.0", paths: {}, components: { schemas: { Fixture: structuredClone(schema) } } },
            docs: { sections: new Map() },
            corrections: {
                routes: [],
                query: [],
                schemas: [{ schema: "Fixture", evidence: ["fluxer_api/src/api/Fixture.ts:1"], ...correction }],
            },
            source: { repository: "fluxerapp/fluxer", commit: "0".repeat(40) },
            stamp: "fixture",
        })
    expect(generate({ property: "missing", branches: [{ type: "object" }] })).toThrow(/lacks/)
    expect(generate({ property: "kept", branches: [{ type: "object" }] })).toThrow(/not an anyOf union/)
    expect(generate({ property: "value", branches: [{ type: "string" }] })).toThrow(/already lists/)
    expect(generate({ remove: ["missing"] })).toThrow(/lacks/)
    expect(generate({ property: "value", branches: [{ type: "object" }], evidence: [] })).toThrow(/cite/)
    expect(generate({ property: "value", branches: [{ type: "object" }] })).not.toThrow()
    expect(generate({ remove: ["kept"] })).not.toThrow()
})
