import { glob } from "astro/loaders"
import { defineCollection } from "astro:content"
import { z } from "astro/zod"

export const collections = {
    docs: defineCollection({
        loader: glob({ pattern: "**/*.{md,mdx}", base: "./content/docs" }),
        schema: z.object({ title: z.string(), description: z.string().optional() }),
    }),
    meta: defineCollection({
        loader: glob({ pattern: "**/meta.json", base: "./content/docs" }),
        schema: z.object({
            title: z.string().optional(),
            description: z.string().optional(),
            pages: z.array(z.string()).optional(),
            root: z.union([z.boolean(), z.string()]).optional(),
        }),
    }),
}
