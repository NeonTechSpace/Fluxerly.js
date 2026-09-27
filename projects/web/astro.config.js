import { defineConfig } from "astro/config"
import react from "@astrojs/react"
import mdx from "@astrojs/mdx"
import tailwindcss from "@tailwindcss/vite"
import { unified } from "@astrojs/markdown-remark"
import { remarkReferenceAnchors } from "./scripts/reference-anchors.js"
import { remarkCommandBlocks } from "./scripts/command-blocks.js"
import { remarkExampleBlocks } from "./scripts/example-blocks.js"
import { remarkProse } from "./scripts/prose.js"
import { rehypeSignatureColors } from "./scripts/signature-colors.js"
import { remarkReferenceLinks } from "./scripts/reference-links.js"
import { rehypeReferenceCode } from "./scripts/reference-code.js"
import { docsHosting } from "./scripts/hosting.js"

export default defineConfig({
    output: "static",
    // Fumadocs normalizes navigation URLs without a trailing slash
    trailingSlash: "ignore",
    markdown: {
        processor: unified({
            remarkPlugins: [remarkReferenceAnchors, remarkReferenceLinks, remarkCommandBlocks, remarkExampleBlocks, remarkProse],
            rehypePlugins: [rehypeSignatureColors, rehypeReferenceCode],
        }),
    },
    integrations: [react(), mdx({ extendMarkdownConfig: true }), docsHosting()],
    vite: { plugins: [tailwindcss()] },
})
