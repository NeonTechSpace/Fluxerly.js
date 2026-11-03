// The conductor's companions: icons of what a bot does, each placed where its meaning belongs in the
// hero. Read left to right they follow the tagline: the radio of the first reply and the keycap and
// bell of a bot's first commands and events where the story starts, a message riding the ribbon toward
// the host, a balloon let go low over the water, a drop of starlight beside the conductor, and
// the megaphone announcing it at the far edge of the water.
//
// They hang at three depths. Far ones sit behind the ribbon in the haze and are not reflected,
// mid and near ones are reflected by the water. Each drifts, bobs and tilts on slow paths of its
// own, and every path starts at its rest pose, so scene time zero is the Still frame.
//
// In Immersive they notice the pointer: one close by leans a little toward it and brightens, and
// as the hero scrolls away they rise a little faster than the page, left behind on the surface.

import { LinearFilter, LinearMipmapLinearFilter, Mesh, NormalBlending, ShaderMaterial, Vector3, type Camera, type PlaneGeometry, type Texture, type TextureLoader } from "three"
import { iconSrc, type IconName } from "../lib/art.ts"
import iconParts from "../lib/icon-parts.json" with { type: "json" }
import { looks, specs, type CompanionDepth, type Spec } from "./companion-specs.ts"
import { stackedQuery, type HeroLayout } from "./layout.ts"
import { companionShader } from "./shaders.ts"

const tau = Math.PI * 2
const degrees = Math.PI / 180
// Art comes in two sizes. The larger loads only when the smaller would be magnified
const smallArt = 320
// Noticing the pointer: it starts this many pixels from a companion's edge and is whole at the
// nearer distance. The lean in degrees at most, how much brighter it gets, and how quickly it turns
// toward the pointer and back, in seconds
const noticeFar = 160
const noticeNear = 40
const noticeLean = 6
const noticeLift = 0.2
const noticeIn = 0.35
const noticeOut = 0.7
// The pointer rests on a companion inside this share of its height from its middle
const onShare = 0.45

interface Companion {
    spec: Spec
    mesh: Mesh<PlaneGeometry, ShaderMaterial>
    ratio: number
    // Rest position in world units, and pixel travel converted to world units
    x: number
    y: number
    z: number
    unit: number
    // Its size on screen in hero pixels
    height: number
    // Sine of each phase, so every motion starts from zero
    rest: [number, number, number, number]
    // How much it is noticing the pointer right now, from 0 to 1, and which way it leans, from -1 to 1
    attention: number
    lean: number
}

// What the companions see of the pointer, in hero pixels. `notice` is how much they may react, 0 at rest
export interface PointerView {
    x: number
    y: number
    notice: number
}

// The companion the pointer rests on, with its middle in hero pixels, or index -1
export interface Under {
    index: number
    x: number
    y: number
}

interface PartSpec {
    src: string
    left: number
    top: number
    width: number
    height: number
    move?: { kind: string; seconds: number; x: number; y: number; turn: number; aroundX: number; aroundY: number }
}

// How long a multi-part icon takes to start moving once its parts have taken over from the whole picture
const partsWake = 2
const partMaterial = (look: { haze: number; opacity: number }) =>
    new ShaderMaterial({
        ...companionShader,
        uniforms: { uMap: { value: null }, uHaze: { value: look.haze }, uOpacity: { value: look.opacity }, uLift: { value: 1 } },
        transparent: true,
        blending: NormalBlending,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
    })

export interface Companions {
    // Brings the multi-part icons' parts, one icon at a time, so the page keeps moving while they land. Only the live scene does
    loadParts(loader: TextureLoader): Promise<void>
    readonly under: Readonly<Under>
    load(loader: TextureLoader, heroHeight: number, pixelRatio: number): Promise<Texture[]>
    place(layout: HeroLayout, focal: number, restHeight: number): void
    update(time: number, drift: number, dip: number, pointer: Readonly<PointerView>, camera: Camera): void
    dispose(): void
}

export function createCompanions(plane: PlaneGeometry, ratios: Record<CompanionDepth, number>, layers: Record<CompanionDepth, number>): Companions & { meshes: Mesh[] } {
    const items: Companion[] = specs.map((spec) => {
        const look = looks[spec.depth]
        const material = new ShaderMaterial({
            ...companionShader,
            uniforms: { uMap: { value: null }, uHaze: { value: look.haze }, uOpacity: { value: look.opacity }, uLift: { value: 1 } },
            transparent: true,
            blending: NormalBlending,
            premultipliedAlpha: true,
            depthTest: false,
            depthWrite: false,
        })
        const mesh = new Mesh(plane, material)
        mesh.layers.set(layers[spec.depth])
        mesh.renderOrder = look.renderOrder
        // Starts visible so the shader compiles with the rest of the scene. Placing hides any without art or room
        mesh.frustumCulled = false
        return { spec, mesh, ratio: ratios[spec.depth], x: 0, y: 0, z: 0, unit: 1, height: 0, rest: spec.phase.map(Math.sin) as Companion["rest"], attention: 0, lean: 0 }
    })
    // Each multi-part icon's parts, made now so they share the scene's programs and hidden until their pictures are all here
    const partsOf = items.map((item) => {
        const look = looks[item.spec.depth]
        const specs = ((iconParts as Partial<Record<IconName, { pieces: PartSpec[] }>>)[item.spec.slug]?.pieces ?? []) as PartSpec[]
        return specs.map((spec, order) => {
            const mesh = new Mesh(plane, partMaterial(look))
            mesh.layers.set(layers[item.spec.depth])
            mesh.renderOrder = look.renderOrder + (order + 1) * 0.001
            mesh.frustumCulled = false
            mesh.visible = false
            return { spec, mesh }
        })
    })
    const partsFrom = items.map(() => Infinity)
    // The icons' load held back on a stacked layout, and the last placing to repeat once they arrive
    let waiting: (() => Promise<unknown>) | null = null
    let lastPlace: (() => void) | null = null
    // After dispose, such as when Still is chosen, nothing more loads and a late texture is freed instead of attached
    let disposed = false
    let stopWaiting: (() => void) | null = null
    const under: Under = { index: -1, x: 0, y: 0 }
    const screen = new Vector3()
    let heroWidth = 1
    let heroHeight = 1
    let lastTime = 0

    return {
        meshes: [...items.map((item) => item.mesh), ...partsOf.flat().map((part) => part.mesh)],
        under,

        async load(loader, heroHeight, pixelRatio) {
            if (disposed) return []
            // A stacked layout shows none of them, so it doesn't pay for them
            if (window.matchMedia(stackedQuery).matches) {
                waiting = () => this.load(loader, heroHeight, pixelRatio).then(() => lastPlace?.())
                return []
            }
            return Promise.all(
                items.map(async (item) => {
                    const needed = item.spec.size * heroHeight * pixelRatio * 1.15
                    const texture = await loader.loadAsync(iconSrc(item.spec.slug, needed > smallArt ? 640 : 320))
                    if (disposed) {
                        texture.dispose()
                        return texture
                    }
                    texture.premultiplyAlpha = true
                    texture.minFilter = LinearMipmapLinearFilter
                    texture.magFilter = LinearFilter
                    texture.generateMipmaps = true
                    item.mesh.material.uniforms.uMap.value = texture
                    return texture
                }),
            )
        },

        async loadParts(loader) {
            if (disposed) return
            // On a screen with no room for them now, the icons and their parts come if it ever has room, such as a window widened
            const query = window.matchMedia(stackedQuery)
            if (query.matches) {
                const unstacked = () => {
                    if (query.matches) return
                    stopWaiting?.()
                    const whole = waiting
                    waiting = null
                    // Nothing awaits this late load, so its failure is reported here, as the first load's is by its caller.
                    // A failed icon leaves the icons unplaced, so they can stay hidden, while failed parts leave them whole
                    void whole?.().then(
                        () =>
                            this.loadParts(loader).catch((reason: unknown) => {
                                if (!disposed) console.warn("The sky's icons stay whole:", reason)
                            }),
                        (reason: unknown) => {
                            if (!disposed) console.warn("The sky's icons could not load and can stay hidden:", reason)
                        },
                    )
                }
                stopWaiting?.()
                query.addEventListener("change", unstacked)
                stopWaiting = () => {
                    query.removeEventListener("change", unstacked)
                    stopWaiting = null
                }
                return
            }
            for (const [index, parts] of partsOf.entries()) {
                if (!parts.length) continue
                const textures = await Promise.all(parts.map((part) => loader.loadAsync(part.spec.src)))
                if (disposed) {
                    for (const texture of textures) texture.dispose()
                    return
                }
                textures.forEach((texture, order) => {
                    texture.premultiplyAlpha = true
                    texture.minFilter = LinearMipmapLinearFilter
                    texture.magFilter = LinearFilter
                    texture.generateMipmaps = true
                    parts[order]!.mesh.material.uniforms.uMap!.value = texture
                })
                partsFrom[index] = lastTime
            }
        },

        place(layout, focal, restHeight) {
            lastPlace = () => this.place(layout, focal, restHeight)
            heroWidth = layout.width
            heroHeight = layout.height
            for (const item of items) {
                const { mesh, ratio, spec } = item
                const texture = mesh.material.uniforms.uMap.value as Texture | null
                const image = texture?.image as { width: number, height: number } | undefined
                mesh.visible = !layout.stacked && Boolean(image) && (spec.fits?.(layout) ?? true)
                if (!image) continue
                // Rest pixels map onto the companion's own depth, like the stars onto theirs
                const [cx, cy] = spec.place(layout)
                const height = spec.size * layout.height
                item.x = (cx - layout.width / 2) * ratio
                item.y = restHeight + (layout.horizon - cy) * ratio
                item.z = -focal * ratio
                item.unit = (layout.height / 1080) * ratio
                item.height = height
                mesh.scale.set(((height * image.width) / image.height) * ratio, height * ratio, 1)
            }
        },

        // Runs every frame, so it reads the numbers by index and allocates nothing
        update(time, drift, dip, pointer, camera) {
            const turns = tau * time
            // Seconds since the last frame. A jump, such as the rest frame drawn for Still, counts as none
            const step = time - lastTime
            const dt = step > 0 && step < 0.25 ? step : 0
            lastTime = time
            camera.updateMatrixWorld()
            under.index = -1
            let closest = Infinity
            for (let i = 0; i < items.length; i++) {
                const item = items[i]
                const { path, bob, tilt, phase } = item.spec
                const rest = item.rest
                const dx = path[0] * (Math.sin(turns / path[2] + phase[0]) - rest[0])
                const dy = path[1] * (Math.sin(turns / path[3] + phase[1]) - rest[1]) + bob[0] * (Math.sin(turns / bob[1] + phase[2]) - rest[2])
                const swing = tilt[1] * (Math.sin(turns / tilt[2] + phase[3]) - rest[3])
                const rise = looks[item.spec.depth].rise * dip * heroHeight * item.ratio
                item.mesh.position.set(item.x + dx * item.unit * drift, item.y - dy * item.unit * drift + rise, item.z)

                // Where it is on screen, and how near the pointer is to its edge
                let target = 0
                if (item.mesh.visible && pointer.notice > 0) {
                    screen.copy(item.mesh.position).project(camera)
                    const sx = (screen.x + 1) * 0.5 * heroWidth
                    const sy = (1 - screen.y) * 0.5 * heroHeight
                    const px = pointer.x - sx
                    const py = pointer.y - sy
                    const distance = Math.hypot(px, py)
                    const edge = Math.max(0, distance - item.height * 0.35)
                    const t = Math.min(1, Math.max(0, (noticeFar - edge) / (noticeFar - noticeNear)))
                    target = t * t * (3 - 2 * t)
                    // Keeps its last lean while it eases back, so it never flips
                    if (target > 0.01) item.lean = Math.max(-1, Math.min(1, px / noticeFar))
                    if (distance < item.height * onShare && distance < closest) {
                        closest = distance
                        under.index = i
                        under.x = sx
                        under.y = sy
                    }
                }
                const ease = 1 - Math.exp(-dt / (target > item.attention ? noticeIn : noticeOut))
                item.attention += (target - item.attention) * ease
                const attention = item.attention * pointer.notice
                // Toward the pointer: the top leans the way it is
                item.mesh.rotation.z = (tilt[0] + swing * drift - item.lean * noticeLean * attention) * degrees
                item.mesh.material.uniforms.uLift.value = 1 + noticeLift * attention

                // Its parts, around the place the whole picture has this frame. The whole picture stands aside once they are here
                const parts = partsOf[i]!
                const live = time >= partsFrom[i]! && item.mesh.visible
                item.mesh.material.visible = !live || parts.length === 0
                if (parts.length) {
                    const age = Math.min(1, Math.max(0, (time - partsFrom[i]!) / partsWake))
                    const wake = age * age * (3 - 2 * age) * drift
                    const angle = item.mesh.rotation.z
                    const cos = Math.cos(angle)
                    const sin = Math.sin(angle)
                    // The picture's long side is the square the parts were placed in
                    const side = Math.max(item.mesh.scale.x, item.mesh.scale.y)
                    for (const part of parts) {
                        part.mesh.visible = live
                        if (!live) continue
                        const { spec } = part
                        const uniforms = part.mesh.material.uniforms
                        uniforms.uLift!.value = item.mesh.material.uniforms.uLift.value
                        const centerX = spec.left + spec.width / 2 - 0.5
                        const centerY = 0.5 - spec.top - spec.height / 2
                        let localX = centerX * side
                        let localY = centerY * side
                        let turn = 0
                        const move = spec.move
                        if (move && move.kind === "sway") {
                            const wave = Math.sin((turns / move.seconds) % tau) * wake
                            turn = -move.turn * wave * degrees
                            const aroundX = (move.aroundX - 0.5) * side
                            const aroundY = (0.5 - move.aroundY) * side
                            const c = Math.cos(turn)
                            const s = Math.sin(turn)
                            const fromX = localX - aroundX
                            const fromY = localY - aroundY
                            localX = aroundX + fromX * c - fromY * s + move.x * side * wave
                            localY = aroundY + fromX * s + fromY * c - move.y * side * wave
                        } else if (move && move.kind === "pulse") {
                            const wave = 0.5 - 0.5 * Math.cos((turns / move.seconds) % tau)
                            uniforms.uOpacity!.value = looks[item.spec.depth].opacity * (1 - 0.7 * wave * wake)
                        }
                        part.mesh.position.set(item.mesh.position.x + localX * cos - localY * sin, item.mesh.position.y + localX * sin + localY * cos, item.mesh.position.z)
                        part.mesh.rotation.z = angle + turn
                        part.mesh.scale.set(spec.width * side, spec.height * side, 1)
                    }
                }
            }
        },

        dispose() {
            disposed = true
            stopWaiting?.()
            waiting = null
            lastPlace = null
            for (const { mesh } of partsOf.flat()) {
                const texture = mesh.material.uniforms.uMap!.value as Texture | null
                texture?.dispose()
                mesh.material.dispose()
            }
            for (const { mesh } of items) {
                const texture = mesh.material.uniforms.uMap.value as Texture | null
                texture?.dispose()
                mesh.material.dispose()
            }
        },
    }
}
