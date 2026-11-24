import { asMarkdown, skillMarkdown } from "../lib/ai-docs"

export const GET = () => asMarkdown(skillMarkdown())
