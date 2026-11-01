// Fine dust in the conductor's sky: a sparse field of tiny specks at two depths, drifting slowly
// toward the conductor's side the way the story runs, from the first reply to the bot of your
// dreams. The far specks sit in the haze behind the ribbon and move least with the camera, the
// near ones just behind the mid companions. Barely visible, never reflected.

import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Vector2 } from "three"
import { seededRandom } from "../lib/stars"
import type { HeroLayout } from "./layout"
import { dustShader } from "./shaders"

const farCount = 64
const nearCount = 48
// Depth of each layer as a multiple of the conductor's depth, between the far companions, the
// ribbon and the mid companions
const farRatio = 4.4
const nearRatio = 1.8

export interface Dust {
    points: Points
    place(layout: HeroLayout, focal: number, restHeight: number, pixelRatio: number): void
    update(time: number): void
    dispose(): void
}

export function createDust(size: Vector2, layer: number): Dust {
    const random = seededRandom(2203)
    const count = farCount + nearCount
    const data = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
        // Sky only: under the header and above the horizon glow, which the shader also fades
        data.set([random(), 0.08 + random() * 0.5, i < farCount ? farRatio : nearRatio, random()], i * 4)
    }
    const geometry = new BufferGeometry()
    // Placement happens in the shader, the position only has to exist
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3))
    geometry.setAttribute("aDust", new BufferAttribute(data, 4))
    const material = new ShaderMaterial({
        ...dustShader,
        uniforms: {
            uSize: { value: size },
            uHalfWidth: { value: 0 },
            uHorizon: { value: 0 },
            uRestHeight: { value: 0 },
            uFocal: { value: 1 },
            uTime: { value: 0 },
            uPixelRatio: { value: 1 },
        },
        transparent: true,
        blending: AdditiveBlending,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
    })
    const points = new Points(geometry, material)
    points.layers.set(layer)
    // After the far companions and the ribbon, before the mid companions
    points.renderOrder = 3.2
    points.frustumCulled = false

    return {
        points,

        place(layout, focal, restHeight, pixelRatio) {
            const uniforms = material.uniforms
            uniforms.uHalfWidth.value = layout.width / 2
            uniforms.uHorizon.value = layout.horizon
            uniforms.uRestHeight.value = restHeight
            uniforms.uFocal.value = focal
            uniforms.uPixelRatio.value = pixelRatio
        },

        update(time) {
            material.uniforms.uTime.value = time
        },

        dispose() {
            geometry.dispose()
            material.dispose()
        },
    }
}
