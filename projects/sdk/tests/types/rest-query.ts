// Compile-only check, run by the test typecheck: A raw REST query accepts arrays of scalar values for a repeated
// parameter in both entry points, and still refuses nested arrays and objects
import type { RestRequest } from "../../src/index.js"
import type { RestRequest as NativeRestRequest } from "../../src/effect.js"

const tags: readonly string[] = ["101", "102"]

export const search: RestRequest = {
    method: "GET",
    path: "/channels/20/threads/search",
    query: { query: "fixture", tag: tags, limit: 5, archived: [false], skipped: undefined },
}

export const nativeSearch: NativeRestRequest = {
    method: "GET",
    path: "/channels/20/threads/search",
    query: { tag: [101, "102"] },
}

export const nested: RestRequest = {
    method: "GET",
    path: "/users/@me",
    // @ts-expect-error A query value may be an array of scalars, not an array of arrays
    query: { tag: [["1"]] },
}

export const nativeObject: NativeRestRequest = {
    method: "GET",
    path: "/users/@me",
    // @ts-expect-error A query value may not be an object
    query: { tag: { id: "1" } },
}
