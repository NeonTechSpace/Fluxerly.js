import { reportCopyFailed } from "../lib/copy-failed"
import { Fragment, useEffect, useRef, useState } from "react"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"
import { segments } from "../../scripts/docs/code-breaks.mjs"

interface Props {
    text: string
}

// Same behavior as the hero's npm chip: copy, show a check for a moment and announce it
export default function CopyButton({ text }: Props) {
    const [copied, setCopied] = useState(false)
    const reset = useRef(0)

    useEffect(() => () => window.clearTimeout(reset.current), [])

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text)
        } catch (error) {
            reportCopyFailed(error)
            return
        }
        setCopied(true)
        window.clearTimeout(reset.current)
        reset.current = window.setTimeout(() => setCopied(false), 1800)
    }

    return (
        <>
            <button className="copy-button" type="button" aria-label={`Copy ${text}`} data-copied={copied || undefined} onClick={copy}>
                <CopyIcon className="icon-copy" size={17} aria-hidden="true" />
                <CheckIcon className="icon-done" size={17} weight="bold" aria-hidden="true" />
            </button>
            <span className="sr-only" aria-live="polite">
                {copied ? "Copied" : ""}
            </span>
        </>
    )
}

// On a phone the command may turn at a space or after a slash in the package name, never inside a word
export function CommandChip({ command, className }: { command: string; className?: string }) {
    const [tool, ...rest] = command.split(" ")
    return (
        <div className={className ? `cmd-chip ${className}` : "cmd-chip"}>
            <code>
                <span className="cmd-tool">{tool}</span>{" "}
                {segments(rest.join(" ")).map((part, at) => (
                    <Fragment key={at}>
                        {at > 0 && <wbr />}
                        {part}
                    </Fragment>
                ))}
            </code>
            <CopyButton text={command} />
        </div>
    )
}
