// The hero world: WebGL water with a planar reflection, the sky layers, the glass dome, stars,
// fine dust, a shooting star, the conductor's companions and the conductor twin. The live scene and the Still frame both draw
// it, so both show the same sky. It renders whatever pose it is given and owns no clock.
//
// Coordinates: the camera sits above the water at y = restHeight and looks down -z.
// The conductor twin sits at depth `focal`, where one world unit equals one CSS pixel,
// so DOM measurements map straight into the scene. Each backdrop layer sits at its own
// multiple of that depth, which sets how far it moves when the camera shifts.

import {
    AdditiveBlending,
    BufferAttribute,
    BufferGeometry,
    DoubleSide,
    LinearFilter,
    LinearMipmapLinearFilter,
    Mesh,
    NormalBlending,
    PerspectiveCamera,
    PlaneGeometry,
    Points,
    Scene,
    ShaderMaterial,
    Texture,
    TextureLoader,
    Vector2,
    Vector3,
    Vector4,
    WebGLRenderer,
} from "three"
import { Reflector } from "three/examples/jsm/objects/Reflector.js"
import { mascotArt } from "../lib/art"
import { createStars } from "../lib/stars"
import { createCompanions, type PointerView, type Under } from "./companions"
import { buildDome } from "./dome"
import { createDust } from "./dust"
import { findHeroParts, measureHero, type HeroLayout } from "./layout"
import { placePulses, ringSeconds, sinceArrival } from "./pulses"
import { createShootingStar } from "./shooting-star"
import { domeShader, skyShader, starShader, twinShader, veilShader, waterShader } from "./shaders"
import { frameKey, scenePixelRatio } from "./still-frame"

export interface Pose {
    // Scene seconds
    time: number
    // How far the conductor has sunk, in CSS pixels
    bob: number
    breath: number
    // Camera offset in CSS pixels at the conductor's depth: sideways, and how far it has dropped toward the water
    shiftX: number
    shiftY: number
    // How far the horizon has risen on screen, in CSS pixels
    lift: number
    // How far the viewer has sunk toward the surface, from 0 to 1
    dip: number
    // Highlight on the twin's waves
    glow: number
    // How much of their slow drift the companions show, 0 at rest
    drift: number
    // How much the companions may notice the pointer, 0 outside Immersive, and the pointer in hero pixels
    notice: number
    pointerX: number
    pointerY: number
}

// The pose the Still frame shows and the live scene starts from
export const restPose: Readonly<Pose> = { time: 0, bob: 0, breath: 1, shiftX: 0, shiftY: 0, lift: 0, dip: 0, glow: 0, drift: 0, notice: 0, pointerX: 0, pointerY: 0 }

export interface World {
    readonly canvas: HTMLCanvasElement
    readonly layout: HeroLayout | null
    // The companion the pointer rests on in the last rendered frame
    readonly under: Readonly<Under>
    // Loads the textures and compiles every shader without blocking the page
    load(): Promise<void>
    // Brings the multi-part icons' parts, for the live scene alone
    loadParts(): Promise<void>
    relayout(): boolean
    render(pose: Readonly<Pose>): void
    // Copies the last rendered frame into a 2D canvas
    capture(frame: HTMLCanvasElement): void
    release(): void
}

// Focal length as a share of the hero height
const focalScale = 1.25
// Depth of each layer as a multiple of the conductor's depth. A layer moves 1 / ratio as far as the
// conductor when the camera shifts. With the conductor at 90 px on a full pointer shift, the near
// companions move 130 px, mid ones 60, the ribbon and nebula 25, far ones 15, the dome and stars 8
const skyRatio = 40
const starRatio = 11.25
const farRatio = 6
const veilRatio = 3.6
const midRatio = 1.5
const nearRatio = 0.69
// Reflection render target size relative to the canvas
const reflectionScale = 0.5
// The dome glint: each pane shines for about a second inside a longer soft pulse, so two
// neighbors often overlap. One sweep takes ten seconds, then a short rest. The first sweep
// waits a moment, so the rest pose shows no glint
const glintCycle = 11.5
const glintSweep = 10
const glintPulse = 1.8
const glintDelay = 1
// The ring a message leaves on the water under the conductor: its radius as shares of the conductor
// width as it starts and as it fades
const ringFrom = 0.12
const ringTo = 1.3

// The ribbon and nebula are painted in shares of a box. That box is the hero, except on an upright phone, where shares of a
// narrow, tall hero would press them together sideways to a quarter of their width. There the box keeps the wide shape they are
// composed for, and the conductor stands at the share of it where it stands on a wide screen, so the phone shows the slice around it
const artAspect = 16 / 9
const artConductor = 0.74

// Layers: the twin is seen only by the reflection camera, the stars and the dome only by the main camera
const twinLayer = 1
const skyLayer = 2

export function createWorld(hero: HTMLElement): World | null {
    const parts = findHeroParts(hero)
    if (!parts) return null

    const canvas = document.createElement("canvas")
    let renderer: WebGLRenderer
    try {
        renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: "high-performance" })
    } catch {
        return null
    }
    renderer.setClearColor(0x02040c, 1)

    const scene = new Scene()
    const camera = new PerspectiveCamera()
    const plane = new PlaneGeometry(1, 1)
    const size = new Vector2()
    const artSize = new Vector2()
    const artLeft = { value: 0 }
    const pulseAlong = new Vector3(-1, -1, -1)
    const pulseStrength = new Vector3()

    const backdropUniforms = (ratio: number) => ({
        uSize: { value: size },
        uHorizon: { value: 0 },
        uTime: { value: 0 },
        uHalfWidth: { value: 0 },
        uRestHeight: { value: 0 },
        uDepthRatio: { value: ratio },
    })

    // Far void and the horizon light
    const sky = new Mesh(plane, new ShaderMaterial({ ...skyShader, uniforms: backdropUniforms(skyRatio), depthTest: false, depthWrite: false }))
    sky.renderOrder = 0
    sky.frustumCulled = false
    scene.add(sky)

    // Stars share their layout with the still sky
    const stars = createStars()
    const starGeometry = new BufferGeometry()
    starGeometry.setAttribute("position", new BufferAttribute(new Float32Array(stars.length * 3), 3))
    starGeometry.setAttribute("aRadius", new BufferAttribute(Float32Array.from(stars, (star) => star.r), 1))
    starGeometry.setAttribute("aAlpha", new BufferAttribute(Float32Array.from(stars, (star) => star.a), 1))
    starGeometry.setAttribute("aPhase", new BufferAttribute(Float32Array.from(stars, (star) => star.phase), 1))
    const starMaterial = new ShaderMaterial({
        ...starShader,
        uniforms: { uPixelRatio: { value: 1 }, uTime: { value: 0 }, uTwinkle: { value: 1 } },
        transparent: true,
        blending: AdditiveBlending,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
    })
    const starPoints = new Points(starGeometry, starMaterial)
    starPoints.layers.set(skyLayer)
    starPoints.renderOrder = 1
    starPoints.frustumCulled = false
    scene.add(starPoints)

    // The glass dome. Its geometry follows the layout, so it is rebuilt on resize
    const domeMaterial = new ShaderMaterial({
        ...domeShader,
        uniforms: {
            uHalfWidth: { value: 0 },
            uHorizon: { value: 0 },
            uFadeTop: { value: 0 },
            uFadeBottom: { value: 0 },
            uGlintTime: { value: 0 },
            uGlintStep: { value: 1 },
            uGlintPulse: { value: glintPulse },
        },
        transparent: true,
        blending: AdditiveBlending,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
        // Seen from inside, the panes wind the other way
        side: DoubleSide,
    })
    const dome = new Mesh(new BufferGeometry(), domeMaterial)
    dome.layers.set(skyLayer)
    dome.renderOrder = 2
    dome.frustumCulled = false
    scene.add(dome)
    let domeKey = ""

    // Nebula and ribbon, nearer than the stars and seen by the water
    const veil = new Mesh(
        plane,
        new ShaderMaterial({
            ...veilShader,
            uniforms: { ...backdropUniforms(veilRatio), uArtSize: { value: artSize }, uArtLeft: artLeft, uPulseAlong: { value: pulseAlong }, uPulseStrength: { value: pulseStrength } },
            transparent: true,
            blending: AdditiveBlending,
            premultipliedAlpha: true,
            depthTest: false,
            depthWrite: false,
        }),
    )
    veil.renderOrder = 3
    veil.frustumCulled = false
    scene.add(veil)

    // The conductor twin is only visible to the reflection camera
    const twinMaterial = new ShaderMaterial({
        ...twinShader,
        uniforms: { uMap: { value: null }, uWaves: { value: null }, uGlow: { value: 0 } },
        transparent: true,
        blending: NormalBlending,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
    })
    const twin = new Mesh(plane, twinMaterial)
    twin.layers.set(twinLayer)
    twin.renderOrder = 4
    twin.frustumCulled = false
    scene.add(twin)

    // The conductor's companions. Far ones are hidden from the water like the stars
    const companions = createCompanions(plane, { far: farRatio, mid: midRatio, near: nearRatio }, { far: skyLayer, mid: 0, near: 0 })
    for (const mesh of companions.meshes) scene.add(mesh)
    const pointer: PointerView = { x: 0, y: 0, notice: 0 }

    // Dust drifting in the sky and the shooting star, both only seen by the main camera
    const dust = createDust(size, skyLayer)
    scene.add(dust.points)
    const shootingStar = createShootingStar(plane, skyLayer)
    scene.add(shootingStar.mesh)

    // Water with a planar reflection of everything above, except the stars and the dome
    const water = new Reflector(plane, { clipBias: 0, multisample: 0, textureWidth: 1, textureHeight: 1, shader: waterShader })
    const waterUniforms = (water.material as ShaderMaterial).uniforms
    waterUniforms.uSize.value = size
    waterUniforms.uTexel.value = new Vector2()
    const ring = new Vector4()
    waterUniforms.uRing.value = ring
    water.rotation.x = -Math.PI / 2
    water.renderOrder = 5
    water.frustumCulled = false
    scene.add(water)
    const reflectionCamera = water.getReflectionCamera(camera)
    reflectionCamera.layers.set(0)
    reflectionCamera.layers.enable(twinLayer)
    camera.layers.set(0)
    camera.layers.enable(skyLayer)

    let layout: HeroLayout | null = null
    let restHeight = 0
    let focal = 1
    let twinX = 0
    let twinY = 0
    let lift = 0
    let pulseEnd = 0
    let key = ""
    let textures: Texture[] = []
    let released = false

    // Off-center frustum: the horizon sits at its CSS line, not mid screen, raised by the given pixels
    const project = (next: HeroLayout, by: number) => {
        const { width, height, horizon } = next
        const near = camera.near
        lift = by
        camera.projectionMatrix.makePerspective(
            (-width / 2 / focal) * near,
            (width / 2 / focal) * near,
            ((horizon - by) / focal) * near,
            (-(height - horizon + by) / focal) * near,
            near,
            camera.far,
        )
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
        waterUniforms.uHorizon.value = horizon - by
    }

    const placeBackdrop = (mesh: Mesh, ratio: number, next: HeroLayout) => {
        const depth = focal * ratio
        const top = restHeight + (next.horizon + next.height * 0.1) * ratio
        const bottom = -restHeight
        mesh.position.set(0, (top + bottom) / 2, -depth)
        mesh.scale.set(next.width * 1.2 * ratio, top - bottom, 1)
        const uniforms = (mesh.material as ShaderMaterial).uniforms
        uniforms.uHorizon.value = next.horizon
        uniforms.uHalfWidth.value = next.width / 2
        uniforms.uRestHeight.value = restHeight
    }

    const relayout = () => {
        if (released) return false
        const next = measureHero(hero, parts)
        if (next.width < 1 || next.height < 1) return false
        layout = next
        const { width, height, horizon } = next
        const pixelRatio = scenePixelRatio()
        focal = focalScale * height
        restHeight = next.waterLine - horizon
        key = frameKey(width, height)

        renderer.setPixelRatio(pixelRatio)
        renderer.setSize(width, height, false)
        size.set(width, height)
        const artWidth = next.uprightPhone ? Math.max(width, height * artAspect) : width
        artSize.set(artWidth, height)
        artLeft.value = next.uprightPhone ? artConductor * artWidth - (next.conductor.left + next.conductor.width / 2) : 0
        camera.near = 1
        camera.far = focal * skyRatio * 1.6
        project(next, lift)

        placeBackdrop(sky, skyRatio, next)
        placeBackdrop(veil, veilRatio, next)

        const starDepth = focal * starRatio
        const positions = starGeometry.getAttribute("position") as BufferAttribute
        stars.forEach((star, i) => {
            positions.setXYZ(i, (star.x * width - width / 2) * starRatio, restHeight + (horizon - star.y * height) * starRatio, -starDepth)
        })
        positions.needsUpdate = true
        starMaterial.uniforms.uPixelRatio.value = pixelRatio

        // The dome is laid out in rest pixels and scaled onto its plane like the stars
        const fadeTop = horizon - height * 0.4
        const fadeBottom = horizon - height * 0.13
        const nextDomeKey = `${width}x${height}:${horizon}`
        if (nextDomeKey !== domeKey) {
            domeKey = nextDomeKey
            const built = buildDome({ width, height, horizon, fadeBottom })
            dome.geometry.dispose()
            dome.geometry = built.geometry
            domeMaterial.uniforms.uGlintStep.value = (glintSweep - glintPulse) / Math.max(1, built.glintPanes - 1)
        }
        dome.position.set(0, restHeight, -starDepth)
        dome.scale.set(starRatio, starRatio, 1)
        domeMaterial.uniforms.uHalfWidth.value = width / 2
        domeMaterial.uniforms.uHorizon.value = horizon
        domeMaterial.uniforms.uFadeTop.value = fadeTop
        domeMaterial.uniforms.uFadeBottom.value = fadeBottom

        const box = next.conductor
        twinX = box.left + box.width / 2 - width / 2
        twinY = restHeight + horizon - (box.top + box.height / 2)
        // Messages run until the ribbon passes behind the conductor's near side
        pulseEnd = (box.left + box.width * 0.08) / width

        companions.place(next, focal, restHeight)
        dust.place(next, focal, restHeight, pixelRatio)
        shootingStar.place(next, focal, restHeight, starRatio)

        const skyDepth = focal * skyRatio
        water.position.set(0, 0, -(skyDepth + 2) / 2)
        water.scale.set(width * 1.2 * skyRatio, skyDepth - 2, 1)
        const targetWidth = Math.max(1, Math.round(width * pixelRatio * reflectionScale))
        const targetHeight = Math.max(1, Math.round(height * pixelRatio * reflectionScale))
        water.getRenderTarget().setSize(targetWidth, targetHeight)
        waterUniforms.uTexel.value.set(1 / targetWidth, 1 / targetHeight)
        waterUniforms.uPixelRatio.value = pixelRatio
        waterUniforms.uFocal.value = focal
        return true
    }

    const render = (pose: Readonly<Pose>) => {
        if (!layout || released) return
        const box = layout.conductor
        if (pose.lift !== lift) project(layout, pose.lift)
        camera.position.set(pose.shiftX, restHeight - pose.shiftY, 0)
        twin.position.set(twinX, twinY - pose.bob, -focal)
        twin.scale.set(box.width * pose.breath, box.height * pose.breath, 1)
        twinMaterial.uniforms.uGlow.value = pose.glow
        pointer.x = pose.pointerX
        pointer.y = pose.pointerY
        pointer.notice = pose.notice
        companions.update(pose.time, pose.drift, pose.dip, pointer, camera)
        dust.update(pose.time)
        shootingStar.update(pose.time)
        placePulses(pose.time, pulseEnd, pulseAlong, pulseStrength)
        // A message that has just reached the conductor spreads one ring on the water under it
        const since = sinceArrival(pose.time)
        if (since >= 0 && since < ringSeconds) {
            const p = since / ringSeconds
            const radius = box.width * (ringFrom + (ringTo - ringFrom) * (1 - (1 - p) ** 2.2))
            ring.set(twinX, -focal, radius, (1 - p) ** 1.6 * Math.min(1, p / 0.06))
        } else {
            ring.w = 0
        }
        sky.material.uniforms.uTime.value = pose.time
        veil.material.uniforms.uTime.value = pose.time
        starMaterial.uniforms.uTime.value = pose.time
        waterUniforms.uTime.value = pose.time
        waterUniforms.uDip.value = pose.dip
        domeMaterial.uniforms.uGlintTime.value = (((pose.time - glintDelay) % glintCycle) + glintCycle) % glintCycle
        renderer.render(scene, camera)
    }

    const load = async () => {
        const loader = new TextureLoader()
        // The conductor and its waves as textures come from the hero's own pictures, which the page has
        // already asked for and decoded, instead of a second download of their small sizes. The texture is as
        // large as the picture the hero chose, up to 1168 wide. A picture that failed is downloaded small
        const fromHero = async (selector: string, fallback: string): Promise<Texture> => {
            const image = hero.querySelector<HTMLImageElement>(selector)
            if (!image) return loader.loadAsync(fallback)
            try {
                await image.decode()
            } catch {
                return loader.loadAsync(fallback)
            }
            // Drawn into a canvas of its own size: uploaded straight from the page's picture, whose source can change with the
            // screen, the browser refused it and the conductor had no reflection at all
            const held = document.createElement("canvas")
            held.width = image.naturalWidth
            held.height = image.naturalHeight
            held.getContext("2d")?.drawImage(image, 0, 0)
            const texture = new Texture(held)
            texture.needsUpdate = true
            return texture
        }
        const loading = Promise.all([fromHero("[data-mascot]", mascotArt.small), fromHero("[data-waves-glow]", mascotArt.wavesSmall)])
        const companionsLoading = companions.load(loader, hero.clientHeight, scenePixelRatio())
        // Companions take their places from where the words end, so wait for the real fonts
        const fonts = document.fonts?.ready.catch(() => {})
        // Shaders compile in the background. The reflection target needs its own variant of each program
        renderer.setRenderTarget(water.getRenderTarget())
        const reflected = renderer.compileAsync(scene, camera)
        renderer.setRenderTarget(null)
        const direct = renderer.compileAsync(scene, camera)
        const [map, waves] = await loading
        textures = [map, waves]
        if (released) {
            for (const texture of textures) texture.dispose()
            throw new Error("released")
        }
        for (const texture of textures) {
            texture.premultiplyAlpha = true
            texture.minFilter = LinearMipmapLinearFilter
            texture.magFilter = LinearFilter
            texture.generateMipmaps = true
        }
        twinMaterial.uniforms.uMap.value = map
        twinMaterial.uniforms.uWaves.value = waves
        const companionTextures = await companionsLoading.catch(() => [])
        if (released) throw new Error("released")
        // Upload now, so the first live frame does not stall on it
        for (const texture of [...textures, ...companionTextures]) renderer.initTexture(texture)
        await Promise.all([reflected, direct, fonts])
        if (released) throw new Error("released")
    }

    const capture = (frame: HTMLCanvasElement) => {
        if (!layout || released) return
        if (frame.width !== canvas.width || frame.height !== canvas.height) {
            frame.width = canvas.width
            frame.height = canvas.height
        }
        const context = frame.getContext("2d", { alpha: false })
        if (!context) return
        // Same task as the render, so the drawing buffer still holds the frame
        context.drawImage(canvas, 0, 0)
        frame.dataset.key = key
    }

    const release = () => {
        if (released) return
        released = true
        for (const texture of textures) texture.dispose()
        textures = []
        plane.dispose()
        starGeometry.dispose()
        dome.geometry.dispose()
        sky.material.dispose()
        veil.material.dispose()
        starMaterial.dispose()
        domeMaterial.dispose()
        twinMaterial.dispose()
        companions.dispose()
        dust.dispose()
        shootingStar.dispose()
        water.dispose()
        renderer.dispose()
        renderer.forceContextLoss()
        canvas.remove()
    }

    return {
        canvas,
        get layout() {
            return layout
        },
        under: companions.under,
        loadParts: () => companions.loadParts(new TextureLoader()),
        load,
        relayout,
        render,
        capture,
        release,
    }
}
