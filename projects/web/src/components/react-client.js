import { createElement, useLayoutEffect } from "react"
import hydrate from "@astrojs/react/client.js"

export default (element) => (Component, ...args) => {
    if (!element.hasAttribute("ssr")) return
    let committed = false
    let unmountRequested = false
    const deferUnmount = (event) => {
        if (committed) return
        // Astro can remove the island before React commits its initial hydration
        event.stopImmediatePropagation()
        unmountRequested = true
    }
    element.addEventListener("astro:unmount", deferUnmount, { capture: true })

    function HydrationBoundary(props) {
        useLayoutEffect(() => {
            committed = true
            element.removeEventListener("astro:unmount", deferUnmount, { capture: true })
            if (unmountRequested) {
                // Teardown must run after React leaves the commit phase
                queueMicrotask(() => element.dispatchEvent(new CustomEvent("astro:unmount")))
            }
        }, [])
        return createElement(Component, props)
    }

    return hydrate(element)(HydrationBoundary, ...args)
}
