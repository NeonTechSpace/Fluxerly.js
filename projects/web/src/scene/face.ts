// Draws the conductor's face glass as a small WebGL picture of its own over the painted conductor: every part of the PSD at its
// own depth with its own motion, and the black hole's parts around a void that swallows light. With nothing moving it gives the
// painted glass again to within a few levels, see faceArt in src/lib/art.ts, so it can take over without being seen

import { LinearFilter, LinearMipmapLinearFilter, Mesh, NoBlending, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Texture, TextureLoader, Vector2, Vector4, WebGLRenderer } from "three"
import { faceArt, type FacePartName } from "../lib/art"
import type { FaceState } from "./face-life"
import { faceShader } from "./shaders"

// The picture's sharpest size: past this a phone's screen spends its memory on detail nobody can see
const maxPixelRatio = 2

export interface FaceFrame {
    time: number
    wake: number
    state: FaceState
    // The waves' light, 0 to 1, and their charge: how far it has filled them, and how strongly it shows, each 0 to 1
    glow: number
    charge: number
    chargeLevel: number
    // Where the viewer stands, each from -1 to 1, which moves the depths in the glass against each other
    viewX: number
    viewY: number
}

export interface Face {
    readonly canvas: HTMLCanvasElement
    // Loads the parts and builds the program without holding the page up
    load(): Promise<void>
    resize(): void
    render(frame: FaceFrame): void
    release(): void
}

const uniformOf: Record<FacePartName, string> = {
    far: "uFar",
    mist: "uMist",
    lens: "uLens",
    flow: "uFlow",
    violet: "uViolet",
    eyes: "uEyes",
    brows: "uBrows",
    waves: "uWaves",
    wavesLight: "uWavesLight",
    crescents: "uCrescents",
    sheen: "uSheen",
    glass: "uGlass",
}

export function createFace(slot: HTMLElement): Face | null {
    const canvas = document.createElement("canvas")
    let renderer: WebGLRenderer
    try {
        renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: "high-performance" })
    } catch {
        return null
    }
    renderer.setClearColor(0x000000, 0)

    const scene = new Scene()
    const camera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1)
    const pair = () => [new Vector4(0, 0, 1, 1), new Vector4(0, 0, 1, 1)]
    const uniforms: Record<string, { value: unknown }> = {
        uTime: { value: 0 },
        uWake: { value: 0 },
        uEye: { value: pair() },
        uBrow: { value: pair() },
        uCheek: { value: pair() },
        uGaze: { value: new Vector2() },
        uCharge: { value: new Vector2() },
        uGlow: { value: 0 },
        uView: { value: new Vector2() },
    }
    for (const name of Object.values(uniformOf)) uniforms[name] = { value: null }
    const material = new ShaderMaterial({ ...faceShader, uniforms, blending: NoBlending, depthTest: false, depthWrite: false })
    const quad = new Mesh(new PlaneGeometry(1, 1), material)
    quad.frustumCulled = false
    scene.add(quad)

    const textures: Texture[] = []
    let released = false

    const resize = () => {
        const width = slot.clientWidth
        const height = slot.clientHeight
        if (!width || !height) return
        // Its own pixels at the conductor's size on screen, which a page zoom makes larger than its layout says
        const zoom = slot.offsetWidth > 0 ? slot.getBoundingClientRect().width / slot.offsetWidth : 1
        renderer.setPixelRatio(Math.min(maxPixelRatio, window.devicePixelRatio * zoom))
        renderer.setSize(width, height, false)
    }

    return {
        canvas,
        resize,
        async load() {
            const loader = new TextureLoader()
            const parts = Object.entries(faceArt.parts) as [FacePartName, { src: string }][]
            const loaded = await Promise.all(parts.map(([, part]) => loader.loadAsync(part.src)))
            if (released) {
                for (const texture of loaded) texture.dispose()
                throw new Error("released")
            }
            parts.forEach(([name], index) => {
                const texture = loaded[index]!
                // The canvas's top row first, as the shader reads it, and color already multiplied by its alpha
                texture.flipY = false
                texture.premultiplyAlpha = true
                texture.minFilter = LinearMipmapLinearFilter
                texture.magFilter = LinearFilter
                texture.generateMipmaps = true
                uniforms[uniformOf[name]]!.value = texture
                textures.push(texture)
            })
            resize()
            await renderer.compileAsync(scene, camera)
            if (released) throw new Error("released")
            // One upload a frame, so the page keeps moving while they land
            for (const texture of textures) {
                renderer.initTexture(texture)
                await new Promise((done) => requestAnimationFrame(done))
                if (released) throw new Error("released")
            }
        },
        render({ time, wake, state, glow, charge, chargeLevel, viewX, viewY }) {
            uniforms.uTime!.value = time
            uniforms.uWake!.value = wake
            const set = (name: string, values: FaceState["eyes"], scaled: boolean) => {
                const out = uniforms[name]!.value as Vector4[]
                values.forEach((part, index) => (scaled ? out[index]!.set(part.x, part.y, part.scaleX, part.scaleY) : out[index]!.set(part.x, part.y, part.turn, 0)))
            }
            set("uEye", state.eyes, true)
            set("uBrow", state.brows, false)
            set("uCheek", state.cheeks, false)
            ;(uniforms.uGaze!.value as Vector2).set(state.gaze.x, state.gaze.y)
            ;(uniforms.uCharge!.value as Vector2).set(charge, chargeLevel)
            uniforms.uGlow!.value = glow
            ;(uniforms.uView!.value as Vector2).set(viewX, viewY)
            renderer.render(scene, camera)
        },
        release() {
            released = true
            for (const texture of textures) texture.dispose()
            material.dispose()
            quad.geometry.dispose()
            renderer.dispose()
            renderer.forceContextLoss()
            canvas.remove()
        },
    }
}
