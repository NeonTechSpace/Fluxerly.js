// Prints the imported guides' headings and fold labels in title case. The guides come from the SDK's repository in sentence case, and an
// import overwrites any edit to the copies, so the site cases them as it renders them. Inline code in a heading is left
// as written, and heading anchors keep working because they are lower case either way
import { titleCase } from "../../src/lib/title-case.ts"

const caseText = (node, first, last) => {
    if (node.type === "text") node.value = titleCase(node.value, { first, last })
    else if (node.children?.length) caseChildren(node, first, last)
}

const caseChildren = (parent, first, last) => {
    parent.children.forEach((child, index) => caseText(child, first && index === 0, last && index === parent.children.length - 1))
}

const walk = (node) => {
    if (node.type === "heading") caseChildren(node, true, true)
    // A fold's label, written as raw HTML in the guides
    else if (node.type === "html") node.value = node.value.replace(/(<summary>)([^<]+)(<\/summary>)/g, (_, open, text, close) => open + titleCase(text) + close)
    else node.children?.forEach(walk)
}

export default function remarkTitles() {
    return (tree) => walk(tree)
}
