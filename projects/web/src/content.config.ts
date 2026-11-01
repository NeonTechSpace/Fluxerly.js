import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"
import { z } from "astro/zod"
import { titleCase } from "./lib/title-case"

// The guides. index.md is the docs overview at /docs/. A published version's build reads the guides from its snapshot
const guides = defineCollection({
    loader: glob({ pattern: "*.md", base: `${process.env.DOCS_CONTENT ?? "./content"}/guides` }),
    schema: z.object({
        title: z.string().transform((title) => titleCase(title)),
        navTitle: z.string().transform((title) => titleCase(title)).optional(),
        description: z.string().optional(),
    }),
})

export const collections = { guides }
