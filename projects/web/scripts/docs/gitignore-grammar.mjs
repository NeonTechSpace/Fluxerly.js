// A grammar for .gitignore and .dockerignore files, which Shiki does not bundle. A comment, the negation that opens
// a pattern, the glob marks, a character class and the slashes each have their own scope, and the path itself is
// an unquoted string, as a shell argument is. Registered wherever the guides' Markdown is rendered
export const gitignoreGrammar = {
    name: "gitignore",
    scopeName: "source.gitignore",
    aliases: ["dockerignore"],
    patterns: [
        { name: "comment.line.number-sign.gitignore", match: "^\\s*#.*$" },
        { name: "keyword.operator.negation.gitignore", match: "^!" },
        { name: "keyword.operator.glob.gitignore", match: "\\*\\*?|\\?" },
        { name: "constant.other.character-class.gitignore", match: "\\[[^\\]]*\\]" },
        { name: "punctuation.separator.path.gitignore", match: "/" },
        { name: "string.unquoted.path.gitignore", match: "[^#!*?\\[/\\s][^*?\\[/\\s]*" },
    ],
    repository: {},
}
