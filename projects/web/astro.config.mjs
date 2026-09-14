import { defineConfig } from "astro/config"
import react from "@astrojs/react"
import mdx from "@astrojs/mdx"
import tailwindcss from "@tailwindcss/vite"
import { unified } from "@astrojs/markdown-remark"
import { remarkStructure } from "fumadocs-core/mdx-plugins"
import { remarkReferenceAnchors } from "./scripts/reference-anchors.mjs"
import { remarkCommandBlocks } from "./scripts/command-blocks.mjs"
import { remarkExampleBlocks } from "./scripts/example-blocks.mjs"
import { remarkProse } from "./scripts/prose.mjs"
import { rehypeSignatureColors } from "./scripts/signature-colors.mjs"

export default defineConfig({
    output: "static",
    // Fumadocs normalizes navigation URLs without a trailing slash
    trailingSlash: "ignore",
    markdown: {
        processor: unified({
            remarkPlugins: [remarkReferenceAnchors, remarkCommandBlocks, remarkExampleBlocks, remarkProse, [remarkStructure, { exportAs: "structuredData" }]],
            rehypePlugins: [rehypeSignatureColors],
        }),
    },
    integrations: [react(), mdx({ extendMarkdownConfig: true })],
    vite: { plugins: [tailwindcss()] },
})
