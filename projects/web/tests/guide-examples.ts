// The number of examples a guide must show. The browser test requires this many visible code blocks and a Node test
// requires the same count from the rendered Markdown, so a guide cannot hide an example in a collapsed section.
// The quick start keeps its troubleshooting and TypeScript examples in collapsed sections and shows six
export function expectedGuideExamples(slug: string, source: string): number {
    if (slug === "quick-start") return 6
    return source.split(/\r?\n/).filter((line) => /^```\S+$/.test(line)).length
}
