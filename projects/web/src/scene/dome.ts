// The geodesic glass dome over the sky: a subdivided icosahedron seen from inside and projected
// into hero pixels once per layout. Seeded jitter makes the panes irregular while shared points
// keep the frame connected. Every pane carries what its shader needs to draw its own share of
// the struts and hubs, so the whole dome is one mesh and one draw call.

import { BufferAttribute, BufferGeometry } from "three"
import { seededRandom } from "../lib/stars"

type Vec3 = [number, number, number]
type Point = [number, number]

interface Hub {
    position: Vec3
    // The icosahedron's own corners are the five way hubs
    major: boolean
    pixel: Point | null
}

interface Pane {
    corners: [Hub, Hub, Hub]
    // Per corner: whether the edge facing that corner lies on an icosahedron edge
    primary: [boolean, boolean, boolean]
}

export interface DomeView {
    width: number
    height: number
    horizon: number
    // Rest pixel line below which the dome has faded out
    fadeBottom: number
}

export interface Dome {
    geometry: BufferGeometry
    glintPanes: number
}

const frequency = 9
const jitter = 0.05
// Share of panes left clear, without a sheen
const clearShare = 0.25
const sheenColors: Vec3[] = [
    [0.56, 0.7, 1.0],
    [0.5, 0.58, 0.94],
    [0.64, 0.57, 1.0],
    [0.72, 0.64, 1.0],
    [0.58, 0.66, 0.91],
]

const golden = (1 + Math.sqrt(5)) / 2
const icoCorners: Vec3[] = [
    [-1, golden, 0], [1, golden, 0], [-1, -golden, 0], [1, -golden, 0],
    [0, -1, golden], [0, 1, golden], [0, -1, -golden], [0, 1, -golden],
    [golden, 0, -1], [golden, 0, 1], [-golden, 0, -1], [-golden, 0, 1],
]
const icoFaces: Vec3[] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
]

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (v: Vec3): Vec3 => {
    const length = Math.hypot(v[0], v[1], v[2])
    return [v[0] / length, v[1] / length, v[2] / length]
}

// Turns the sphere so one five way hub sits near the zenith, a little off the page's axis
function orient(v: Vec3): Vec3 {
    const tilt = Math.atan2(1, golden)
    const yaw = 0.42
    const x = v[0] * Math.cos(tilt) + v[1] * Math.sin(tilt)
    const y = -v[0] * Math.sin(tilt) + v[1] * Math.cos(tilt)
    return [x * Math.cos(yaw) - v[2] * Math.sin(yaw), y, x * Math.sin(yaw) + v[2] * Math.cos(yaw)]
}

function buildPanes(): { hubs: Hub[], panes: Pane[] } {
    const byKey = new Map<string, Hub>()
    const panes: Pane[] = []
    for (const face of icoFaces) {
        const [a, b, c] = face.map((index) => icoCorners[index])
        const hubAt = (i: number, j: number) => {
            const raw: Vec3 = [0, 1, 2].map((axis) => a[axis] + ((b[axis] - a[axis]) * i) / frequency + ((c[axis] - a[axis]) * j) / frequency) as Vec3
            const position = orient(unit(raw))
            const key = position.map((value) => value.toFixed(4)).join()
            let hub = byKey.get(key)
            if (!hub) {
                hub = { position, major: false, pixel: null }
                byKey.set(key, hub)
            }
            if ((i === 0 && j === 0) || (i === frequency && j === 0) || (i === 0 && j === frequency)) hub.major = true
            return hub
        }
        // An edge is primary when both ends sit on the same side of the big face
        const onSide = (p: Point, q: Point) =>
            (p[1] === 0 && q[1] === 0) || (p[0] === 0 && q[0] === 0) || (p[0] + p[1] === frequency && q[0] + q[1] === frequency)
        const pane = (p: Point, q: Point, r: Point) => {
            panes.push({
                corners: [hubAt(p[0], p[1]), hubAt(q[0], q[1]), hubAt(r[0], r[1])],
                primary: [onSide(q, r), onSide(r, p), onSide(p, q)],
            })
        }
        for (let i = 0; i < frequency; i++) {
            for (let j = 0; j < frequency - i; j++) {
                pane([i, j], [i + 1, j], [i, j + 1])
                if (i + j < frequency - 1) pane([i + 1, j], [i + 1, j + 1], [i, j + 1])
            }
        }
    }
    return { hubs: [...byKey.values()], panes }
}

// Built once per page: the sphere does not depend on the layout
let sphere: { hubs: Hub[], panes: Pane[] } | null = null

function jitteredSphere() {
    if (sphere) return sphere
    sphere = buildPanes()
    const random = seededRandom(5309)
    for (const hub of sphere.hubs) {
        if (hub.major) continue
        const across = unit(Math.abs(hub.position[1]) > 0.98 ? [1, 0, 0] : cross(hub.position, [0, 1, 0]))
        const along = cross(hub.position, across)
        const shiftA = (random() - 0.5) * jitter
        const shiftB = (random() - 0.5) * jitter
        hub.position = unit([0, 1, 2].map((axis) => hub.position[axis] + across[axis] * shiftA + along[axis] * shiftB) as Vec3)
    }
    return sphere
}

// The viewer stands inside, a little above the dome's base and behind its center, looking up
function projector(view: DomeView) {
    const eye: Vec3 = [0, 0.1, 0.42]
    const pitch = (16 * Math.PI) / 180
    const focal = 0.56 * view.width
    const forward: Vec3 = [0, Math.sin(pitch), -Math.cos(pitch)]
    const up: Vec3 = [0, Math.cos(pitch), Math.sin(pitch)]
    // Eye level lands on the hero horizon
    const centerY = view.horizon - focal * Math.tan(pitch)
    return (p: Vec3): Point | null => {
        const d: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]
        const depth = dot(d, forward)
        if (depth < 0.08) return null
        return [view.width / 2 + (focal * d[0]) / depth, centerY - (focal * dot(d, up)) / depth]
    }
}

function insideTriangle(p: Point, a: Point, b: Point, c: Point) {
    const side = (u: Point, v: Point) => (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0])
    const s1 = side(a, b)
    const s2 = side(b, c)
    const s3 = side(c, a)
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
}

// The glint follows panes along an arc that rises at the left, crosses the sky above the title
// and settles just short of the conductor
function glintPath(view: DomeView, panes: { points: [Point, Point, Point] }[]) {
    const from: Point = [0.02 * view.width, view.horizon * 0.4]
    const peak: Point = [0.24 * view.width, view.horizon * 0.1]
    const to: Point = [0.56 * view.width, view.horizon * 0.14]
    const order = new Map<number, number>()
    const samples = 400
    for (let s = 0; s <= samples; s++) {
        const t = s / samples
        const v = 1 - t
        const p: Point = [v * v * from[0] + 2 * v * t * peak[0] + t * t * to[0], v * v * from[1] + 2 * v * t * peak[1] + t * t * to[1]]
        const index = panes.findIndex((pane) => insideTriangle(p, ...pane.points))
        if (index >= 0 && !order.has(index)) order.set(index, order.size)
    }
    return order
}

export function buildDome(view: DomeView): Dome {
    const { hubs, panes } = jitteredSphere()
    const project = projector(view)
    for (const hub of hubs) hub.pixel = hub.position[1] > -0.05 ? project(hub.position) : null

    const margin = 60
    const visible = (p: Point) => p[0] > -margin && p[0] < view.width + margin && p[1] > -margin && p[1] < view.fadeBottom + margin
    const shown = panes
        .filter((pane) => pane.corners.every((hub) => hub.pixel) && pane.corners.some((hub) => visible(hub.pixel!)))
        .map((pane) => ({ ...pane, points: pane.corners.map((hub) => hub.pixel!) as [Point, Point, Point] }))

    const glint = glintPath(view, shown)
    const random = seededRandom(7741)
    const light = unit([0.5, 0.62, -0.6])
    const count = shown.length * 3
    const position = new Float32Array(count * 3)
    const bary = new Float32Array(count * 3)
    const heights = new Float32Array(count * 3)
    const cornersAB = new Float32Array(count * 4)
    const cornerC = new Float32Array(count * 4)
    const primary = new Float32Array(count * 3)
    const major = new Float32Array(count * 3)
    const sheen = new Float32Array(count * 4)

    shown.forEach((pane, index) => {
        const [a, b, c] = pane.points
        // Twice the area, then each corner's distance to the edge facing it
        const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
        const altitude = (p: Point, q: Point) => area / Math.max(Math.hypot(q[0] - p[0], q[1] - p[1]), 1e-3)
        const normal = unit(pane.corners.reduce<Vec3>((sum, hub) => [sum[0] + hub.position[0], sum[1] + hub.position[1], sum[2] + hub.position[2]], [0, 0, 0]))
        const facing = Math.max(0, dot(normal, light)) ** 3
        const clear = random() < clearShare
        const strength = clear ? 0 : 0.035 + random() * 0.045 + facing * 0.04
        const color = sheenColors[Math.floor(random() * sheenColors.length)]
        const sheenCorner = Math.floor(random() * 3)
        const glintOrder = glint.get(index) ?? -1

        for (let k = 0; k < 3; k++) {
            const v = index * 3 + k
            const point = pane.points[k]
            position.set([point[0] - view.width / 2, view.horizon - point[1], 0], v * 3)
            bary.set([k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0], v * 3)
            heights.set([altitude(b, c), altitude(c, a), altitude(a, b)], v * 3)
            cornersAB.set([a[0], a[1], b[0], b[1]], v * 4)
            cornerC.set([c[0], c[1], glintOrder, sheenCorner], v * 4)
            primary.set(pane.primary.map(Number), v * 3)
            major.set(pane.corners.map((hub) => Number(hub.major)), v * 3)
            sheen.set([...color, strength], v * 4)
        }
    })

    const geometry = new BufferGeometry()
    geometry.setAttribute("position", new BufferAttribute(position, 3))
    geometry.setAttribute("aBary", new BufferAttribute(bary, 3))
    geometry.setAttribute("aHeights", new BufferAttribute(heights, 3))
    geometry.setAttribute("aCornersAB", new BufferAttribute(cornersAB, 4))
    geometry.setAttribute("aCornerC", new BufferAttribute(cornerC, 4))
    geometry.setAttribute("aPrimary", new BufferAttribute(primary, 3))
    geometry.setAttribute("aMajor", new BufferAttribute(major, 3))
    geometry.setAttribute("aSheen", new BufferAttribute(sheen, 4))
    return { geometry, glintPanes: glint.size }
}
