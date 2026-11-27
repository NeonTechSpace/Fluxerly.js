// Draws the conductor's face glass as a small WebGL picture of its own over the painted conductor: every part of the PSD at its
// own depth with its own motion, and the black hole's parts around a void that swallows light. With nothing moving it gives the
// painted glass again to within a few levels, see faceArt in src/lib/art.ts, so it can take over without being seen

import { LinearFilter, LinearMipmapLinearFilter, Mesh, NoBlending, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Texture, TextureLoader, Vector2, Vector4, WebGLRenderer } from "three"
import { faceArt, type FacePartName } from "../lib/art"
import type { FaceState } from "./face-life"
import { faceDustCount, faceShader, fillFaceDust } from "./face-shader"

// The picture's sharpest size: past this a phone's screen spends its memory on detail nobody can see
const maxPixelRatio = 2
const mistSpeed = (Math.PI * 2) / 90

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
    // Loads the parts and builds the program without holding the page up; optional gate waits before GPU compile and upload
    load(readyToUpload?: Promise<void>): Promise<void>
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
    const eyeUniforms = [new Vector4(0, 0, 1, 1), new Vector4(0, 0, 1, 1)]
    const browUniforms = [new Vector4(0, 0, 1, 0), new Vector4(0, 0, 1, 0)]
    const cheekUniforms = [new Vector4(0, 0, 1, 0), new Vector4(0, 0, 1, 0)]
    const gazeUniform = new Vector2()
    const chargeUniform = new Vector2()
    const viewUniform = new Vector2()
    const mistTurnUniform = new Vector2(1, 0)
    const dustPos = new Float32Array(faceDustCount * 2)
    const dustMeta = new Float32Array(faceDustCount * 4)
    fillFaceDust(0, dustPos, dustMeta)

    const timeUniform = { value: 0 }
    const wakeUniform = { value: 0 }
    const glowUniform = { value: 0 }
    const blinkUniform = { value: 0 }
    const uniforms: Record<string, { value: unknown }> = {
        uTime: timeUniform,
        uWake: wakeUniform,
        uBlink: blinkUniform,
        uEye: { value: eyeUniforms },
        uBrow: { value: browUniforms },
        uCheek: { value: cheekUniforms },
        uGaze: { value: gazeUniform },
        uCharge: { value: chargeUniform },
        uGlow: glowUniform,
        uView: { value: viewUniform },
        uMistTurn: { value: mistTurnUniform },
        uDustPos: { value: dustPos },
        uDustMeta: { value: dustMeta },
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
        async load(readyToUpload) {
            const loader = new TextureLoader()
            const parts = Object.entries(faceArt.parts) as [FacePartName, { src: string }][]
            const loaded = await Promise.all(parts.map(([, part]) => loader.loadAsync(part.src)))
            if (readyToUpload) await readyToUpload
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
            if (renderer.getContext().getExtension("KHR_parallel_shader_compile")) await renderer.compileAsync(scene, camera)
            else renderer.compile(scene, camera)
            if (released) throw new Error("released")
            // One upload a frame, so the page keeps moving while they land
            for (const texture of textures) {
                renderer.initTexture(texture)
                await new Promise((done) => requestAnimationFrame(done))
                if (released) throw new Error("released")
            }
        },
        render(frame) {
            const { time, wake, state, glow, charge, chargeLevel, viewX, viewY } = frame
            timeUniform.value = time
            wakeUniform.value = wake
            blinkUniform.value = state.blink
            const eye0 = state.eyes[0]
            const eye1 = state.eyes[1]
            eyeUniforms[0]!.set(eye0.x, eye0.y, eye0.scaleX, eye0.scaleY)
            eyeUniforms[1]!.set(eye1.x, eye1.y, eye1.scaleX, eye1.scaleY)
            const brow0 = state.brows[0]
            const brow1 = state.brows[1]
            browUniforms[0]!.set(brow0.x, brow0.y, Math.cos(-brow0.turn), Math.sin(-brow0.turn))
            browUniforms[1]!.set(brow1.x, brow1.y, Math.cos(-brow1.turn), Math.sin(-brow1.turn))
            const cheek0 = state.cheeks[0]
            const cheek1 = state.cheeks[1]
            cheekUniforms[0]!.set(cheek0.x, cheek0.y, Math.cos(-cheek0.turn), Math.sin(-cheek0.turn))
            cheekUniforms[1]!.set(cheek1.x, cheek1.y, Math.cos(-cheek1.turn), Math.sin(-cheek1.turn))
            gazeUniform.set(state.gaze.x, state.gaze.y)
            chargeUniform.set(charge, chargeLevel)
            glowUniform.value = glow
            viewUniform.set(viewX, viewY)
            if (wake > 0) {
                const mistAngle = time * mistSpeed
                mistTurnUniform.set(Math.cos(mistAngle), Math.sin(mistAngle))
                fillFaceDust(time, dustPos, dustMeta)
            }
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
