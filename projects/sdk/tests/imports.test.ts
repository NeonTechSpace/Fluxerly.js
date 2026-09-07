import { expect, test } from "vitest"
import { createClient } from "#sdk/index"
import { createClient as createNativeClient } from "#sdk/effect"
import { createClient as createSourceClient } from "../src/index.js"
import { createClient as createNativeSourceClient } from "../src/effect.js"

test("SDK aliases resolve to the public source modules in source tests", () => {
    expect(createClient).toBe(createSourceClient)
    expect(createNativeClient).toBe(createNativeSourceClient)
})
