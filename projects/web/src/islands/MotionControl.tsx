import { useEffect, useState } from "react"
import { getExperience, setExperience, subscribeExperience, type Experience } from "../lib/experience"
import "./motion-control.css"

// One switch in the header that turns the site's motion on and off. On is Immersive, off is Still,
// which is this site's reduce motion setting. The icon is the conductor's two waves, rolling while
// motion is on and stopped where they are once it is off. Beside them sits what a press does next,
// pause or play, the way any player marks it, so the state reads without hovering. The tooltip is the
// header's shared one, styled in Header.astro
export default function MotionControl() {
    // Unknown until the island runs in the browser
    const [mode, setMode] = useState<Experience | null>(null)
    const moving = mode !== "still"

    useEffect(() => {
        setMode(getExperience())
        return subscribeExperience(setMode)
    }, [])

    return (
        <span className="mode-control">
            <button
                type="button"
                className="motion"
                role="switch"
                aria-checked={moving}
                aria-label="Motion"
                aria-describedby="motion-tip"
                data-ready={mode !== null || undefined}
                onClick={() => setExperience(moving ? "still" : "immersive")}
            >
                {/* Each wave runs three periods long, one either side of the window, so sliding it by exactly
                    one period loops without a seam. The strip slides as a whole picture, which the compositor moves
                    without asking the page to lay out or paint again */}
                <span className="motion-waves" aria-hidden="true">
                    <svg className="motion-strip" viewBox="-15 0 54 24" focusable="false">
                        <path className="motion-wave" d="M-15 9c3-3.6 6-3.6 9 0s6 3.6 9 0 6-3.6 9 0 6 3.6 9 0 6-3.6 9 0 6 3.6 9 0" />
                        <path className="motion-wave motion-wave-low" d="M-15 15c3-3.6 6-3.6 9 0s6 3.6 9 0 6-3.6 9 0 6 3.6 9 0 6-3.6 9 0 6 3.6 9 0" />
                    </svg>
                </span>
                <svg className="motion-next" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                    {moving ? <path className="motion-pause" d="M3.6 2.4v7.2M8.4 2.4v7.2" /> : <path className="motion-play" d="M3.4 2.2 9.8 6 3.4 9.8Z" />}
                </svg>
            </button>
            {/* Hidden from assistive technology, which hears it once as the switch's description */}
            <span className="mode-tip" id="motion-tip" aria-hidden="true">
                {moving ? "Pause motion" : "Play motion"}
            </span>
        </span>
    )
}
