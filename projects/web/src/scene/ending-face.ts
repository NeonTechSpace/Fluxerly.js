// The black hole of the conductor at the end of the page, drawn by the hero's own face shader with HOLE_ONLY, see face-shader.ts, so
// it moves as the hero's does: space streams in and bends around the void and its far side's light arcs over the top. Plain
// WebGL rather than three.js, so a page without the hero's scene loads only this. It draws only while it is on screen and the
// hero's face is not moving, see face-turn.ts, and at its first frame it is the painted glass again, so it takes over unseen

import { faceArt, type FacePartName } from "../lib/art"
import { heroFaceMoving, onHeroFace } from "./face-turn"
import { faceShader } from "./face-shader"

export interface EndingFace {
    readonly canvas: HTMLCanvasElement
    // Loads the parts and builds the program without holding the page up
    load(): Promise<void>
    release(): void
}

// The picture's sharpest size, as the hero's face
const maxPixelRatio = 2
// How long it takes to come alive from the painted glass, as the hero's face
const wakeSeconds = 2.6
// The parts the black hole and the glass under it are made of. The rest are the end of the page's own layers
const partNames = ["far", "lens", "flow", "violet", "sheen", "glass"] as const satisfies readonly FacePartName[]
const uniformOf: Record<(typeof partNames)[number], string> = { far: "uFar", lens: "uLens", flow: "uFlow", violet: "uViolet", sheen: "uSheen", glass: "uGlass" }

const smooth = (from: number, to: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
    return t * t * (3 - 2 * t)
}

// The sources as three.js would give them to the GPU: its attributes and precision before them, and nothing else changed
export const endingFaceSources = {
    vertex: `precision highp float;\nattribute vec3 position;\nattribute vec2 uv;\n${faceShader.vertexShader}`,
    fragment: `#define HOLE_ONLY\nprecision highp float;\n${faceShader.fragmentShader}`,
}

const compile = (gl: WebGL2RenderingContext, type: number, source: string) => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`the black hole's shader: ${gl.getShaderInfoLog(shader)}`)
    return shader
}

// Gives null where WebGL 2 is missing. If the GPU drops it later, it lets go and calls onLost. Building the program and taking in each
// picture each wait for resting(), such as until the page has stopped scrolling, since each can cost a long frame
export function createEndingFace(slot: HTMLElement, onLost: () => void, resting: () => Promise<void> = async () => {}): EndingFace | null {
    const canvas = document.createElement("canvas")
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true })
    if (!gl) return null
    canvas.dataset.endingFace = ""

    let released = false
    let ready = false
    let program: WebGLProgram | null = null
    const textures: WebGLTexture[] = []
    const buffers: WebGLBuffer[] = []
    let uTime: WebGLUniformLocation | null = null
    let uWake: WebGLUniformLocation | null = null

    // Its own clock runs only while it draws, so it carries on where it stopped rather than jumping
    let sceneTime = 0
    let last = -1
    let frame = 0
    let onScreen = false

    const resize = () => {
        const width = slot.clientWidth
        const height = slot.clientHeight
        if (!width || !height) return
        // Its own pixels at the conductor's size on screen, which a page zoom makes larger than its layout says
        const zoom = slot.offsetWidth > 0 ? slot.getBoundingClientRect().width / slot.offsetWidth : 1
        const ratio = Math.min(maxPixelRatio, window.devicePixelRatio * zoom)
        canvas.width = Math.round(width * ratio)
        canvas.height = Math.round(height * ratio)
        if (ready) draw()
    }

    const draw = () => {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.uniform1f(uTime, sceneTime)
        gl.uniform1f(uWake, smooth(0, wakeSeconds, sceneTime))
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    const tick = (now: number) => {
        frame = 0
        if (last >= 0) sceneTime += Math.min(0.1, (now - last) / 1000)
        last = now
        draw()
        frame = requestAnimationFrame(tick)
    }

    // Moves while it is on screen and the hero's face is not moving. Held, it keeps its last frame
    const follow = () => {
        const moves = ready && !released && onScreen && !heroFaceMoving()
        if (moves && !frame) {
            last = -1
            frame = requestAnimationFrame(tick)
        } else if (!moves && frame) {
            cancelAnimationFrame(frame)
            frame = 0
        }
    }
    const leaveTurn = onHeroFace(follow)
    const viewObserver = new IntersectionObserver((entries) => {
        onScreen = Boolean(entries[entries.length - 1]?.isIntersecting)
        follow()
    })
    const resizeObserver = new ResizeObserver(resize)

    const release = () => {
        if (released) return
        released = true
        follow()
        leaveTurn()
        viewObserver.disconnect()
        resizeObserver.disconnect()
        for (const texture of textures) gl.deleteTexture(texture)
        for (const buffer of buffers) gl.deleteBuffer(buffer)
        if (program) gl.deleteProgram(program)
        gl.getExtension("WEBGL_lose_context")?.loseContext()
        canvas.remove()
    }
    canvas.addEventListener("webglcontextlost", () => {
        if (released) return
        release()
        onLost()
    })

    return {
        canvas,
        release,
        async load() {
            const pictures = await Promise.all(
                partNames.map(async (name) => {
                    const picture = new Image()
                    picture.src = faceArt.parts[name].src
                    await picture.decode()
                    return picture
                }),
            )
            await resting()
            if (released) throw new Error("released")

            program = gl.createProgram()!
            gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, endingFaceSources.vertex))
            gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, endingFaceSources.fragment))
            gl.linkProgram(program)
            if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`the black hole's shader: ${gl.getProgramInfoLog(program)}`)
            gl.useProgram(program)

            // One quad over the glass, as three.js's plane of 1 by 1 with its texture's top row at the top
            const attribute = (name: string, values: number[], size: number) => {
                const buffer = gl.createBuffer()!
                buffers.push(buffer)
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(values), gl.STATIC_DRAW)
                const at = gl.getAttribLocation(program!, name)
                if (at < 0) return
                gl.enableVertexAttribArray(at)
                gl.vertexAttribPointer(at, size, gl.FLOAT, false, 0, 0)
            }
            attribute("position", [-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3)
            attribute("uv", [0, 0, 1, 0, 0, 1, 1, 1], 2)

            uTime = gl.getUniformLocation(program, "uTime")
            uWake = gl.getUniformLocation(program, "uWake")
            gl.uniform1f(gl.getUniformLocation(program, "uGlow"), 0)
            gl.uniform2f(gl.getUniformLocation(program, "uView"), 0, 0)
            gl.uniform2f(gl.getUniformLocation(program, "uCharge"), 0, 0)

            // As the hero's face takes them: the top row first, color already multiplied by its alpha and no color conversion
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
            for (const [index, name] of partNames.entries()) {
                await resting()
                if (released) throw new Error("released")
                const texture = gl.createTexture()!
                textures.push(texture)
                gl.activeTexture(gl.TEXTURE0 + index)
                gl.bindTexture(gl.TEXTURE_2D, texture)
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pictures[index]!)
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
                gl.generateMipmap(gl.TEXTURE_2D)
                gl.uniform1i(gl.getUniformLocation(program, uniformOf[name]), index)
                // One upload a frame, so the page keeps moving while they land
                await new Promise((done) => requestAnimationFrame(done))
                if (released) throw new Error("released")
            }
            gl.disable(gl.BLEND)
            gl.clearColor(0, 0, 0, 0)

            // Its first frame, where the GPU may finish building the program
            await resting()
            if (released) throw new Error("released")
            ready = true
            resize()
            resizeObserver.observe(slot)
            viewObserver.observe(slot)
        },
    }
}
