import { glob } from "astro/loaders"
import { defineCollection } from "astro:content"
import { z } from "astro/zod"

export const collections = {
    docs: defineCollection({
        loader: glob({ pattern: "**/*.{md,mdx}", base: "./content/docs" }),
        schema: z.object({
            title: z.string(),
            navTitle: z.string().trim().min(1).optional(),
            description: z.string().optional(),
            snapshotSchema: z.number().int().positive().optional(),
        }),
    }),
    meta: defineCollection({
        loader: glob({ pattern: "**/meta.json", base: "./content/docs" }),
        schema: z.object({
            title: z.string().optional(),
            description: z.string().optional(),
            pages: z.array(z.string()).optional(),
            root: z.union([z.boolean(), z.string()]).optional(),
            // Reference entry points list source-assigned categories for sidebar navigation
            categories: z.record(z.string(), z.array(z.object({ title: z.string(), anchor: z.string() }))).optional(),
        }),
    }),
}
