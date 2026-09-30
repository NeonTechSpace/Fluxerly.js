import { defineConfig } from "astro/config"
import { fileURLToPath } from "node:url"
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

// Astro can unmount a React island before its first hydration commits, which React reports as error #424.
// The wrapped client entry holds that teardown until the commit and otherwise keeps Astro's own renderer
const reactIntegration = react()
const setupReact = reactIntegration.hooks["astro:config:setup"]
reactIntegration.hooks["astro:config:setup"] = (context) => setupReact({
    ...context,
    addRenderer: (renderer) => context.addRenderer({
        ...renderer,
        clientEntrypoint: fileURLToPath(new URL("./src/components/react-client.js", import.meta.url)),
    }),
})

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
    integrations: [reactIntegration, mdx({ extendMarkdownConfig: true }), docsHosting()],
    vite: { plugins: [tailwindcss()] },
})
