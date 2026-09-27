import { expect, test } from "vitest"
import { createClient } from "#sdk/index"
import { createClient as createNativeClient } from "#sdk/effect"
import { createClient as createSourceClient } from "../../src/index.js"
import { createClient as createNativeSourceClient } from "../../src/effect.js"
import { hostedDiscoveryDocument, hostedDiscoveryUrl } from "../../src/internal/testing/discovery.js"

test("SDK aliases resolve to the public source modules in source tests", () => {
    expect(createClient).toBe(createSourceClient)
    expect(createNativeClient).toBe(createNativeSourceClient)
})

test("the packed-consumer discovery fixture copy matches the source hosted discovery document", async () => {
    // The .mjs copy exists because the packed-consumer layout cannot import src, so a non-literal specifier keeps it untyped
    const copy = (await import(new URL("../support/hosted-discovery.mjs", import.meta.url).href)) as Record<
        string,
        unknown
    >
    expect(copy.hostedDiscoveryDocument).toStrictEqual(hostedDiscoveryDocument)
    expect(copy.hostedDiscoveryUrl).toBe(hostedDiscoveryUrl)
})
