// The conductor's companions: which icon stands where, and how each depth is seen. The page draws them from these at its first paint,
// and the scene in companions.ts draws them from the same numbers once it is ready. Nothing here needs Three.js

import type { IconName } from "../lib/art"
import type { HeroLayout } from "./layout"

// Saved once the sky's icons have all arrived on a visit, so later visits know they are in the browser's cache
export const skyIconsKey = "fluxerly.sky-icons.v1"

export type CompanionDepth = "far" | "mid" | "near"

export interface Spec {
    // Which icon, made by scripts/prepare-art.mjs
    slug: IconName
    depth: CompanionDepth
    // Height as a share of the hero height
    size: number
    // Rest center in hero pixels
    place(layout: HeroLayout): [number, number]
    // Whether the composition leaves it enough room to travel with the parallax without reaching the words
    fits?(layout: HeroLayout): boolean
    // Slow path: sideways and vertical travel in pixels on a 1080 tall hero, then each period in seconds
    path: [number, number, number, number]
    // Bob: travel in pixels and period in seconds
    bob: [number, number]
    // Tilt in degrees: rest angle, swing, then the swing period in seconds
    tilt: [number, number, number]
    // Phase of the path, bob and tilt, so neighbours never move in step
    phase: [number, number, number, number]
}

const between = (a: number, b: number, t: number) => a + (b - a) * t
// The ribbon's leading edge in hero pixels, the same curve the veil shader draws at rest
const ribbon = (layout: HeroLayout, x: number) => {
    const u = Math.max(x / layout.width, 0)
    return (0.6 - 0.05 * u - 0.5 * u ** 2.4 + 0.014 * Math.sin(u * 2.2) * u) * layout.height
}
// The open sky between the words and the conductor, and the strip right of the conductor
const gap = (layout: HeroLayout, t: number) => between(layout.text.right, layout.conductor.left, t)
const gapWider = (layout: HeroLayout, share: number) => layout.conductor.left - layout.text.right > layout.height * share
const beyond = (layout: HeroLayout, t: number) => between(layout.conductor.left + layout.conductor.width, layout.width, t)

export const specs: Spec[] = [
    {
        // The first reply going out on the air, above the start of the story
        slug: "first-reply-radio",
        depth: "near",
        size: 0.15,
        place: (l) => [between(l.text.left, l.text.right, 0.69), l.height * 0.172],
        // Above the wordmark or clear beside it
        fits: (l) => l.title.top > l.height * 0.25 + 12 || between(l.text.left, l.text.right, 0.69) - l.height * 0.075 > l.title.right + 12,
        path: [32, 15, 38, 27],
        bob: [6, 7.2],
        tilt: [-12, 3.5, 13],
        phase: [0.3, 2.1, 4.0, 1.2],
    },
    {
        // The keycap of a first command, far off
        slug: "commands-key",
        depth: "far",
        size: 0.05,
        place: (l) => [between(l.text.left, l.text.right, 0.2), l.height * 0.165],
        // Only where the sky above the wordmark has room for it
        fits: (l) => l.title.top > l.height * 0.19 + 12,
        path: [12, 7, 41, 23],
        bob: [3, 8.2],
        tilt: [12, 3, 15],
        phase: [1.9, 0.4, 2.7, 5.1],
    },
    {
        // The bell of the events a bot listens for, swaying far off
        slug: "events-bell",
        depth: "far",
        size: 0.052,
        place: (l) => [gap(l, 0.4), l.height * 0.15],
        path: [13, 6, 57, 34],
        bob: [3, 9],
        tilt: [-6, 4, 17],
        phase: [4.1, 3.3, 0.9, 2.2],
    },
    {
        // A message on its way, riding the ribbon up toward the host and drifting back. Its path
        // starts toward the conductor and mostly stays on that side, clear of the words
        slug: "messages-plane",
        depth: "mid",
        size: 0.085,
        place: (l) => [gap(l, 0.47), ribbon(l, gap(l, 0.47)) - l.height * 0.056],
        fits: (l) => gapWider(l, 0.27),
        path: [24, -8, 31, 31],
        bob: [5, 6.3],
        tilt: [-6, 3, 9.5],
        phase: [5.76, 5.76, 1.4, 3.8],
    },
    {
        // A bot let out into the world, rising off the water
        slug: "deploy-balloon",
        depth: "mid",
        size: 0.08,
        place: (l) => [gap(l, 0.78), l.horizon - l.height * 0.06],
        fits: (l) => gapWider(l, 0.16),
        path: [18, 4, 47, 29],
        bob: [4, 6.8],
        tilt: [5, 2.5, 12],
        phase: [5.2, 1.1, 3.6, 0.2],
    },
    {
        // A drop of the conductor's starlight, kept close beside it
        slug: "star-drop",
        depth: "near",
        size: 0.135,
        place: (l) => [beyond(l, 0.52), l.height * 0.235],
        path: [22, 17, 44, 31],
        bob: [7, 6.4],
        tilt: [8, 4, 11],
        phase: [0.8, 4.4, 2.2, 3.1],
    },
    {
        // Announcing it at the far edge of the water, swaying just above its own reflection
        slug: "announce-megaphone",
        depth: "mid",
        size: 0.095,
        place: (l) => [beyond(l, 0.6), l.horizon - l.height * 0.05],
        path: [13, 4, 52, 36],
        bob: [4, 7.6],
        tilt: [0, 3, 8.7],
        phase: [3.4, 5.6, 0.5, 4.7],
    },
]

// How each depth is seen. Distance thins the color toward the night and lets some sky through.
// `rise` is how much faster than the page it leaves as the hero scrolls away, the near ones most
export const looks: Record<CompanionDepth, { haze: number, opacity: number, renderOrder: number, rise: number }> = {
    // Between the dome and the ribbon, so the ribbon passes in front
    far: { haze: 0.28, opacity: 0.8, renderOrder: 2.5, rise: 0.08 },
    // In front of the ribbon, behind the conductor
    mid: { haze: 0.08, opacity: 1, renderOrder: 3.5, rise: 0.16 },
    near: { haze: 0, opacity: 1, renderOrder: 4.5, rise: 0.24 },
}
