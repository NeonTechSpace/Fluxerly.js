// Only one living face moves at a time, so the page never draws two. The hero's comes first: while it moves, the black hole of
// the conductor at the end of the page holds its last frame, and it moves on once the hero's face is still or gone

const heroFaces = new Set<object>()
const listeners = new Set<() => void>()

// Whether a hero's face is moving now. Each scene says so for itself, since an older one may still be fading out
export function setHeroFaceMoving(owner: object, moving: boolean) {
    if (moving === heroFaces.has(owner)) return
    if (moving) heroFaces.add(owner)
    else heroFaces.delete(owner)
    for (const listener of listeners) listener()
}

export const heroFaceMoving = () => heroFaces.size > 0

// Calls back whenever that changes, until the returned function is called
export function onHeroFace(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
