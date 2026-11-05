import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"
import { z } from "astro/zod"
import { aliasKey, aliasWords } from "./lib/docs-search"
import { titleCase } from "./lib/title-case"

// A phrase that search reads as another name for a guide. It has no commas and at most aliasWords words
const searchPhrase = z.string().refine((term) => !term.includes(",") && aliasKey(term).split(" ").length <= aliasWords, {
    message: `A search phrase has no commas and at most ${aliasWords} words`,
})

// The guides. index.md is the docs overview at /docs/. A published version's build reads the guides from its snapshot
const guides = defineCollection({
    loader: glob({ pattern: "*.md", base: `${process.env.DOCS_CONTENT ?? "./content"}/guides` }),
    schema: z.object({
        title: z.string().transform((title) => titleCase(title)),
        // The sidebar label. Search reads it as it reads the title, so it follows the rules of a search phrase
        navTitle: searchPhrase.transform((title) => titleCase(title)).optional(),
        description: z.string().optional(),
        // Other words readers use for the guide's topic, such as getting started for the quick start. Search reads them as it
        // reads the title, and a query that holds one whole always gets the guide ranked
        search: z.array(searchPhrase).optional(),
    }),
})

export const collections = { guides }
