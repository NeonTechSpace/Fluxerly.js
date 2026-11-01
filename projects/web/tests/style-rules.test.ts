import assert from "node:assert/strict"
import { globSync, readFileSync } from "node:fs"
import { test } from "node:test"

// The site's small design choices are named once at the top of src/styles/global.css. These tests fail on a raw value, so
// the consistency holds however a change gets made. Art keeps its colors

const files = globSync("src/**/*.{astro,css}").map((file) => file.replaceAll("\\", "/"))

// The CSS of a file: all of a stylesheet, or a component's style blocks
const cssOf = (file: string) => {
    const source = readFileSync(file, "utf8").replaceAll("\r\n", "\n")
    if (file.endsWith(".css")) return source
    return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join("\n")
}

const offenders = (find: (css: string) => string[]) => files.flatMap((file) => find(cssOf(file)).map((value) => `${file}: ${value}`))

// The wordmark in the header is the logo, drawn at its own sizes
const logoSizes = /^(18|21|22|26)px$/

test("font sizes come from the shared steps", () => {
    const raw = offenders((css) =>
        [...css.matchAll(/(?<![\w-])font-size:\s*([^;]+);/g)].map((match) => match[1]!.trim()).filter((value) => /^[\d.]+px$/.test(value) && !logoSizes.test(value)),
    )
    assert.deepEqual(raw, [])
})

test("font weights come from the shared steps", () => {
    const raw = offenders((css) => {
        const outsideFaces = css.replace(/@font-face\s*\{[^}]*\}/g, "")
        return [...outsideFaces.matchAll(/font-weight:\s*(\d+)\s*;/g)].map((match) => match[1]!)
    })
    assert.deepEqual(raw, [])
})

test("corners come from the shared steps, smaller ones being hairlines on thin marks", () => {
    const raw = offenders((css) =>
        [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1]!.trim()).filter((value) => /\b([4-9]|[1-9]\d+)px\b/.test(value) && !value.includes("var(")),
    )
    assert.deepEqual(raw, [])
})

test("every rounded box uses the smooth corner", () => {
    const raw = offenders((css) => [...css.matchAll(/border-radius:\s*(?:0 )?var\(--corner-(?:small|medium|large)\)[^;]*;(?!\s*corner-shape)\s*([^\s]*)/g)].map((match) => `no corner-shape, next: ${match[1]}`))
    assert.deepEqual(raw, [])
})

test("short transitions use the shared speeds", () => {
    const raw = offenders((css) =>
        [...css.matchAll(/(?<![\w-])transition(?:-duration)?:([^;{}]*);/g)].flatMap((match) =>
            match[1]!
                .split(/,(?![^()]*\))/)
                .map((part) => /(\d+)ms/.exec(part))
                .filter((found) => found && Number(found[1]) >= 100 && Number(found[1]) <= 420)
                .map((found) => found![0]),
        ),
    )
    assert.deepEqual(raw, [])
})

// The named colors, then the dark washes of the sky and space, the npm coin, the maker's badge and the docs' own tones.
// A new interface color belongs in global.css with a name, not here
const known = new Set(
    `#46e3ef #a57cff #ecc46e #eef0ff #c3c8e6 #04051a #070a26 #9aa1c6 #dfe6ff #8ef1f7 #c8fbff #b597ff #c8b4ff #dccdff #b9c7ff #7fe3a6 #7fb0ff
    #02030f #02040c #02040e #020412 #03040f #03051a #04061c #04101c #050820 #060a24 #06101a #071a2c #080a22 #080d2a #0b0e2a #0b0e2e #0d1131
    #1aa9b8 #3fb6f2 #7152d6 #7d1129 #86d2fa #9ea2ff #a51d38 #c4c7ff #c9962e #c99a48 #e2505f #f0a8c8 #f4fdff #f6d98f #f7f8ff #f8dfa0 #ff8f9c #fff5f6 #ffffff`.split(/\s+/),
)

test("no new color appears outside the named ones", () => {
    const raw = offenders((css) => [...css.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toLowerCase()).filter((color) => !known.has(color)))
    assert.deepEqual(raw, [])
})

// A media query can't know about a saved choice, and it would overrule one. <html data-still> carries the answer, see src/lib/experience.ts
test("motion follows data-still, not the system's setting directly", () => {
    const raw = offenders((css) => css.match(/@media[^{]*prefers-reduced-motion/g) ?? [])
    // Without script nothing can read a saved choice, so the fallback for that case is the one place
    assert.deepEqual(raw.filter((line) => !line.startsWith("src/components/PageTransitions.astro")), [])
})
