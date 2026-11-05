import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { defineConfig } from "astro/config"
import react from "@astrojs/react"
import tailwindcss from "@tailwindcss/vite"
import { unified } from "@astrojs/markdown-remark"
import remarkGuides from "./scripts/docs/remark-guides.mjs"
import remarkEntries from "./scripts/docs/remark-entries.mjs"
import remarkTitles from "./scripts/docs/remark-titles.mjs"
import rehypeCodeBreaks, { codeLineIndent, collapseLongCode, remarkLongCode } from "./scripts/docs/code-breaks.mjs"
import rehypeExternalLinks from "./src/lib/external-links.mjs"
import { siteOrigin } from "./src/lib/site-address.mjs"
import remarkExampleAddresses from "./scripts/docs/remark-example-addresses.mjs"
import sitemap from "./scripts/sitemap.mjs"
import { buildPeek } from "./src/lib/peek-index.ts"
import rehypePeek from "./src/lib/rehype-peek.ts"
import fluxerlyTheme from "./src/styles/shiki-fluxerly.json" with { type: "json" }
import { gitignoreGrammar } from "./scripts/docs/gitignore-grammar.mjs"

// The names, codes and terms the guides' prose is marked with, from the reference model, the code catalogue and the glossary
// The build reads one content folder: the working tree's, or a published version's snapshot when scripts/docs/build-public.mjs names one
const contentRoot = resolve(process.env.DOCS_CONTENT ?? fileURLToPath(new URL("./content", import.meta.url)))
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const readContent = (path) => readFileSync(join(contentRoot, path), "utf8")
const peekSources = { model: readContent("reference/model.json"), codes: readContent("reference/codes.json"), glossary: readContent("guides/glossary.md") }
const { terms: peekTerms } = buildPeek({ model: JSON.parse(peekSources.model), codes: JSON.parse(peekSources.codes), glossary: peekSources.glossary })
// Astro keeps rendered guides until its config changes, and neither the tables above nor the recogniser's code are part
// of what it compares. Their digest is, so a new reference model, glossary or recogniser renders the guides again
const peekDigest = createHash("sha256")
    .update([...Object.values(peekSources), read("./src/lib/peek-index.ts"), read("./src/lib/peek-meanings.ts"), read("./src/lib/rehype-peek.ts")].join("\n"))
    .digest("hex")

export default defineConfig({
    site: siteOrigin,
    output: "static",
    integrations: [react(), sitemap()],
    markdown: {
        // The guides keep their straight quotes, as code and prose in them are written. Tables of sentences become
        // entries, the names, codes and terms in the prose are marked for their peeks, and inline code wraps only at
        // the seams of its identifiers. The marks come first, so they read each code's whole text. Links that leave the
        // site open in a new tab, and an example address Markdown would link by itself reads as code
        processor: unified({
            remarkPlugins: [remarkExampleAddresses, remarkGuides, remarkLongCode, remarkEntries, remarkTitles],
            rehypePlugins: [[rehypePeek, { terms: peekTerms, digest: peekDigest }], rehypeCodeBreaks, rehypeExternalLinks],
            smartypants: false,
        }),
        shikiConfig: { theme: fluxerlyTheme, langs: [gitignoreGrammar], transformers: [codeLineIndent, collapseLongCode] },
    },
    vite: {
        plugins: [tailwindcss()],
        resolve: { alias: { "@content": contentRoot } },
        // The dev server keeps its own dependency cache. Builds run in the same project while it is up, and sharing one
        // cache with them left it serving a React runtime that no longer matched, so every island failed to render
        cacheDir: process.argv.includes("dev") ? "node_modules/.vite-dev" : undefined,
        // The dev server bundles these once at start instead of finding them on a page later, which made it re-bundle
        // mid-session and answer "504 Outdated Optimize Dep" until a reload broke every island
        optimizeDeps: {
            include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "three", "three/examples/jsm/objects/Reflector.js", "gsap", "@phosphor-icons/react"],
        },
    },
})
