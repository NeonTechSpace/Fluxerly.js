import { Fragment, type CSSProperties } from "react"
import { codeIndent, codeLines } from "./code-wrap"

interface Props {
    code: string
    // Line indexes that get the lit or quiet highlight
    lit?: number
    quiet?: number
}

// The React twin of CodeBlock.astro, for code inside islands
export default function CodeLines({ code, lit = -1, quiet = -1 }: Props) {
    const raw = code.replace(/\n$/, "").split("\n")
    const indent = (line: string): CSSProperties | undefined => {
        const width = codeIndent(line)
        return width > 0 ? ({ "--indent": `${width}ch` } as CSSProperties) : undefined
    }
    return (
        <code>
            {codeLines(code).map((pieces, index) => (
                <span key={index} className={index === lit ? "ln is-lit" : index === quiet ? "ln is-quiet" : "ln"} style={indent(raw[index])} data-line={index}>
                    {pieces.map((piece, at) =>
                        piece.space ? (
                            piece.text
                        ) : (
                            <Fragment key={at}>
                                {piece.seam && <wbr />}
                                <span className={piece.kind === "plain" ? "tw" : `tw tk-${piece.kind}`}>{piece.text}</span>
                            </Fragment>
                        ),
                    )}
                </span>
            ))}
        </code>
    )
}
