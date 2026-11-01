import { asMarkdown, tasksMarkdown } from "../../../lib/ai-docs"

export const GET = () => asMarkdown(tasksMarkdown())
