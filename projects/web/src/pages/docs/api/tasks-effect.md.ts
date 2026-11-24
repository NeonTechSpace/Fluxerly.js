import { asMarkdown, tasksMarkdownFor } from "../../../lib/ai-docs"

export const GET = () => asMarkdown(tasksMarkdownFor("effect"))
