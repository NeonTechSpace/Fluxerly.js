// Geometry of the trimmed mascot derivatives made by scripts/prepare-art.mjs.
// Keep these numbers in sync with the crop in that script.

export const mascotArt = {
    width: 1168,
    height: 1676,
    // Average height of the two eye centers, as a fraction of the trimmed image height
    eyeLine: 0.5791,
    small: "/art/mascot-584.webp",
    large: "/art/mascot-1168.webp",
    wavesSmall: "/art/waves-glow-584.webp",
    wavesLarge: "/art/waves-glow-1168.webp",
    // At the end of the page: the conductor, and the cloth of its cap apart, which the updraft fills
    endingBody: "/art/ending-body-584.webp",
    endingBase: "/art/ending-base-584.webp",
    endingFan: "/art/ending-fan-584.webp",
    endingFold: "/art/ending-fold-584.webp",
    endingSeat: "/art/ending-seat-584.webp",
} as const

// The living face: the glass's parts from the PSD, each cut to its own box of the 2048 canvas by scripts/prepare-art.mjs, which
// src/scene/face-shader.ts draws. Stacked as the PSD stacks them they are the painted glass again. Nothing but the live scenes ask
// for them
const facePart = (name: string, left: number, top: number, width: number, height: number) => ({ src: `/art/face/${name}.webp`, left, top, width, height })
export const faceArt = {
    // The glass's box on the canvas, which the shader draws, and the same box inside the trimmed mascot, where the page puts it
    glass: { left: 537, top: 800, width: 992, height: 815 },
    slot: { left: 537 - 450, top: 800 - 98, width: 992, height: 815 },
    parts: {
        far: facePart("far", 537, 800, 992, 815),
        mist: facePart("mist", 537, 682, 992, 992),
        lens: facePart("lens", 595, 1369, 865, 192),
        flow: facePart("flow", 595, 1369, 865, 192),
        violet: facePart("violet", 595, 1369, 865, 192),
        eyes: facePart("eyes", 613, 894, 802, 337),
        brows: facePart("brows", 640, 860, 750, 116),
        waves: facePart("waves", 830, 1040, 366, 316),
        wavesLight: facePart("waves-light", 830, 1040, 366, 316),
        crescents: facePart("crescents", 600, 1187, 848, 168),
        sheen: facePart("sheen", 537, 800, 992, 815),
        glass: facePart("glass", 537, 800, 992, 815),
    },
} as const
export type FacePartName = keyof typeof faceArt.parts

// The conductor comes at three widths, so the browser can take the one nearest the size the hero draws it:
// about 390 device pixels at 1920x1080, 730 at 2560x1329 at scale 1.5 and 780 at 3840x2160 with the page
// zoom. scripts/prepare-art.mjs writes them
export const mascotWidths = [584, 876, 1168] as const
const mascotFile = (width: number) => `/art/mascot-${width}.webp`
export const mascotSrcset = mascotWidths.map((width) => `${mascotFile(width)} ${width}w`).join(", ")
// The width of the conductor's file at this address, or undefined for another picture
export const mascotWidthOf = (address: string) => mascotWidths.find((width) => address.endsWith(mascotFile(width)))
// The hero conductor's bow tie and what lies under it, at the same widths, so the browser picks the same size as for the conductor
export const bowFile = (width: number) => `/art/bow-${width}.webp`
export const bowUnderFile = (width: number) => `/art/bow-under-${width}.webp`
export const bowSrcset = mascotWidths.map((width) => `${bowFile(width)} ${width}w`).join(", ")

// The conductor's box as Hero.astro lays it out, so the browser picks the picture nearest the size it draws
// instead of the largest: the room between the eye line, at 38% of the height, and the 84px the hat keeps clear of
// the header, divided by the eye line's share of the box's height: 45.7% of the height less 101px. A hero up to 860px
// tall has its eye line at 33%: 39.7% less 101px. Never wider than four of the twelve columns. On a phone 52% of the
// width up to 280px. The page zoom of wide screens is folded into the pixels, and into the heights that count as
// short. The same list goes on the preload in Site.astro
export const mascotSizes = [
    "(min-width: 3200px) and (max-height: 1290px) min(calc(33.3vw - 72px), calc(39.7vh - 152px))",
    "(min-width: 3200px) min(calc(33.3vw - 72px), calc(45.7vh - 152px))",
    "(min-width: 2400px) and (max-height: 989px) min(calc(33.3vw - 55px), calc(39.7vh - 116px))",
    "(min-width: 2400px) min(calc(33.3vw - 55px), calc(45.7vh - 116px))",
    "(min-width: 1920px) and (max-height: 860px) min(calc(33.3vw - 48px), calc(39.7vh - 101px))",
    "(min-width: 1920px) min(calc(33.3vw - 48px), calc(45.7vh - 101px))",
    "(min-width: 900px) and (max-height: 860px) min(30.8vw, calc(39.7vh - 101px))",
    "(min-width: 900px) min(30.8vw, calc(45.7vh - 101px))",
    "min(52vw, 280px)",
].join(", ")

// The icons the site places, by name. scripts/prepare-art.mjs cuts each at these widths, 160 for small places such
// as the menu and the docs, 320 and 640 for the sky and the sections
export type IconName =
    | "first-reply-radio"
    | "effect-plug"
    | "results-signpost"
    | "commands-key"
    | "logs-scroll"
    | "testing-flask"
    | "production-server"
    | "data-database"
    | "neonflux-bot"
    | "roles-tags"
    | "messages-plane"
    | "events-bell"
    | "webhook-hook"
    | "announce-megaphone"
    | "retry-loop"
    | "cooldown-hourglass"
    | "shutdown-switch"
    | "deploy-balloon"
    | "support-lifebuoy"
    | "toolbox"
    | "sdk-package"
    | "star-drop"
    | "guard-shield"
    | "api-book"
    | "permission-lock"
    | "cache-disc"
    | "emoji-jack"
    | "config-sliders"
    | "errors-beacon"

export const iconSrc = (name: IconName, width: 160 | 320 | 640) => `/art/icons/${name}-${width}.webp`

// The icon of each docs page, by the page's path under /docs/. Pages without one stand on their title alone
export const docsIcons: Readonly<Record<string, IconName>> = {
    index: "star-drop",
    "create-a-bot": "neonflux-bot",
    "quick-start": "first-reply-radio",
    "small-bot": "neonflux-bot",
    examples: "toolbox",
    messages: "messages-plane",
    "announcement-channels": "announce-megaphone",
    commands: "commands-key",
    "events-and-collectors": "events-bell",
    "guilds-and-permissions": "permission-lock",
    "history-and-cache": "cache-disc",
    "emoji-and-stickers": "emoji-jack",
    "webhooks-and-oauth": "webhook-hook",
    // The shield with its engraved check, for the list a bot is checked against before it runs unattended
    "production-checklist": "guard-shield",
    configuration: "config-sliders",
    logging: "logs-scroll",
    reliability: "retry-loop",
    "starter-lifetime": "shutdown-switch",
    deploying: "deploy-balloon",
    sharding: "production-server",
    "application-supervision": "shutdown-switch",
    testing: "testing-flask",
    "effect-first-bot": "effect-plug",
    "effect-workflows": "effect-plug",
    "effect-application-testing": "testing-flask",
    "where-do-i": "results-signpost",
    troubleshooting: "errors-beacon",
    codes: "errors-beacon",
    faq: "support-lifebuoy",
    glossary: "api-book",
    "support-and-compatibility": "support-lifebuoy",
    api: "api-book",
}

// Each feature page's icon, the one its hero carries
export const featureIcons = {
    "first-reply": "first-reply-radio",
    effect: "effect-plug",
    results: "results-signpost",
    commands: "commands-key",
    logs: "logs-scroll",
    testing: "testing-flask",
    production: "production-server",
    data: "data-database",
    raw: "api-book",
} as const satisfies Record<string, IconName>
