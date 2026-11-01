import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"

// The moving icons: the list of parts and what prepare-art wrote from it have to agree, and every picture has to be there

const parts = JSON.parse(readFileSync("scripts/icon-parts/parts.json", "utf8")) as Record<string, { name: string; move?: { seconds: number } }[]>
const written = JSON.parse(readFileSync("src/lib/icon-parts.json", "utf8")) as Record<string, { shadow: string; pieces: { src: string; left: number; top: number; width: number; height: number; move?: { seconds: number } }[] }>

test("every icon listed has its parts written, under its outline, and no others", () => {
    assert.deepEqual(Object.keys(written).sort(), Object.keys(parts).sort())
    for (const [slug, slices] of Object.entries(parts)) {
        assert.equal(written[slug]!.pieces.length, slices.length + 1, slug)
        assert.match(written[slug]!.pieces[0]!.src, /outline\.webp$/, slug)
    }
})

test("every picture exists and sits inside its icon's square", () => {
    for (const [slug, set] of Object.entries(written)) {
        assert.ok(existsSync(`public${set.shadow}`), set.shadow)
        for (const piece of set.pieces) {
            assert.ok(existsSync(`public${piece.src}`), piece.src)
            assert.ok(piece.left >= -0.001 && piece.top >= -0.001 && piece.left + piece.width <= 1.001 && piece.top + piece.height <= 1.001, `${slug} ${piece.src}`)
        }
    }
})

test("an icon's parts don't all keep the same time, so they never move as one", () => {
    for (const [slug, slices] of Object.entries(parts)) {
        const moving = slices.filter((slice) => slice.move)
        assert.ok(moving.length > 0, `${slug} has no moving part`)
        // Two parts of one rigid piece may share a beat, as the loop and its rod do
        if (moving.length > 2) assert.ok(new Set(moving.map((slice) => slice.move!.seconds)).size > 1, slug)
    }
})
