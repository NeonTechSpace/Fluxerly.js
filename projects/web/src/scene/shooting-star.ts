// A shooting star once in each breath of the conductor's waves, while they are at their darkest.
// It falls at the depth of the stars and the dome, high across the open sky between the words and
// the conductor, above the observatory, and is gone before it reaches the hat. The sky only: the
// water does not mirror it.

import { AdditiveBlending, Mesh, ShaderMaterial, type PlaneGeometry } from "three"
import type { HeroLayout } from "./layout"
import { noise, starSeconds, starStart, breathSeconds } from "./rhythm"
import { shootingStarShader } from "./shaders"

// Room past the head for its glow, and half the quad's width, in pixels
const pad = 12
const half = 7

export interface ShootingStar {
    mesh: Mesh<PlaneGeometry, ShaderMaterial>
    place(layout: HeroLayout, focal: number, restHeight: number, ratio: number): void
    update(time: number): void
    dispose(): void
}

export function createShootingStar(plane: PlaneGeometry, layer: number): ShootingStar {
    const material = new ShaderMaterial({
        ...shootingStarShader,
        uniforms: { uLength: { value: 1 }, uReach: { value: 1 }, uHalf: { value: half }, uAlpha: { value: 0 } },
        transparent: true,
        blending: AdditiveBlending,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
    })
    const mesh = new Mesh(plane, material)
    mesh.layers.set(layer)
    // Over the dome, under the ribbon
    mesh.renderOrder = 2.2
    mesh.frustumCulled = false
    // Starts visible so the shader compiles with the rest of the scene. The first frame hides it
    mesh.visible = true

    let layout: HeroLayout | null = null
    let restHeight = 0
    let depth = 0
    let ratio = 1

    return {
        mesh,

        place(next, focal, height, depthRatio) {
            layout = next
            restHeight = height
            ratio = depthRatio
            depth = focal * depthRatio
        },

        // Runs every frame and allocates nothing
        update(time) {
            mesh.visible = false
            if (!layout || layout.stacked) return
            const breath = Math.floor(time / breathSeconds)
            const p = (time - starStart(breath)) / starSeconds
            if (p <= 0 || p >= 1) return
            const { width, height } = layout
            // Each star takes its own line: where it starts, how steeply it falls and how far it goes
            const fromX = width * (0.31 + 0.05 * noise(breath, 7))
            const fromY = height * (0.012 + 0.02 * noise(breath, 8))
            const angle = ((14 + 6 * noise(breath, 9)) * Math.PI) / 180
            const travel = width * (0.18 + 0.04 * noise(breath, 10))
            const trail = height * (0.09 + 0.03 * noise(breath, 11))
            const dx = Math.cos(angle)
            const dy = Math.sin(angle)
            // Quick at first, easing as it burns out
            const reached = travel * (1 - (1 - p) ** 1.5)
            const length = Math.max(1, Math.min(trail, reached + 2))
            const headX = fromX + dx * reached
            const headY = fromY + dy * reached
            const reach = length + pad
            // The quad's middle, from the tail to just past the head
            const midX = headX - dx * (length - pad) * 0.5
            const midY = headY - dy * (length - pad) * 0.5
            mesh.position.set((midX - width / 2) * ratio, restHeight + (layout.horizon - midY) * ratio, -depth)
            mesh.rotation.z = -angle
            mesh.scale.set(reach * ratio, half * 2 * ratio, 1)
            const uniforms = material.uniforms
            uniforms.uLength.value = length
            uniforms.uReach.value = reach
            uniforms.uAlpha.value = Math.min(1, p / 0.12) * Math.min(1, (1 - p) / 0.4) * 0.9
            mesh.visible = true
        },

        dispose() {
            material.dispose()
        },
    }
}
