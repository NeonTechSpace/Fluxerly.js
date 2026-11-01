// One fixed star field shared by the static sky and the WebGL sky,
// so stars stay in place when the scene fades in.

export interface Star {
    // Position as a fraction of the hero box
    x: number
    y: number
    // Radius in CSS pixels
    r: number
    // Brightness from 0 to 1
    a: number
    // Twinkle phase in radians
    phase: number
}

// Small seeded generator, so every layout draws the same sky
export function seededRandom(seed: number) {
    let t = seed >>> 0
    return () => {
        t = (t + 0x6d2b79f5) >>> 0
        let v = Math.imul(t ^ (t >>> 15), 1 | t)
        v = (v + Math.imul(v ^ (v >>> 7), 61 | v)) ^ v
        return ((v ^ (v >>> 14)) >>> 0) / 4294967296
    }
}

// Bright stars next to text read as stray dots, so only faint ones may sit there
function nearText(x: number, y: number) {
    return x > 0.07 && x < 0.42 && y > 0.24 && y < 0.56
}

export function createStars(count = 128, seed = 1709): Star[] {
    const random = seededRandom(seed)
    const stars: Star[] = []
    while (stars.length < count) {
        const tier = random()
        // Most stars are faint specks, a few are clearly brighter
        const r = tier < 0.72 ? 0.45 + random() * 0.4 : tier < 0.94 ? 0.85 + random() * 0.45 : 1.35 + random() * 0.55
        const a = tier < 0.72 ? 0.22 + random() * 0.3 : tier < 0.94 ? 0.45 + random() * 0.3 : 0.75 + random() * 0.25
        const x = random()
        // Clear of the header, and fewer stars close to the horizon glow
        const y = 0.1 + Math.pow(random(), 1.25) * 0.46
        const phase = random() * Math.PI * 2
        if (r > 0.85 && nearText(x, y)) continue
        stars.push({
            x,
            y,
            r: Math.round(r * 100) / 100,
            a: Math.round(a * 100) / 100,
            phase: Math.round(phase * 100) / 100,
        })
    }
    return stars
}
