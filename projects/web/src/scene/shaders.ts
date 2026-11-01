import { faceArt } from "../lib/art"

// GLSL for the hero scene. Colors are written as sRGB values, the same numbers as the CSS,
// and the shaders skip color space conversion so the live sky matches the still one.

const dither = /* glsl */ `
    float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }

    // Breaks up 8 bit banding in the dark gradients
    vec3 dithered(vec3 color) {
        return color + (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
    }
`

// Smooth value noise and its sum over four octaves. Needs hash12 from the dither block
const noise = /* glsl */ `
    float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
            mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
            u.y
        );
    }

    float fbm(vec2 p) {
        float sum = 0.0;
        float amp = 0.5;
        for (int i = 0; i < 4; i++) {
            sum += amp * valueNoise(p);
            p = p * 2.03 + vec2(17.1, 9.2);
            amp *= 0.5;
        }
        return sum;
    }
`

// Maps a world point on a backdrop layer back to the hero pixel it covers when the camera rests
const restPixel = /* glsl */ `
    uniform float uHalfWidth;
    uniform float uHorizon;
    uniform float uRestHeight;
    uniform float uDepthRatio;

    vec2 restPixel(vec3 world) {
        return vec2(uHalfWidth + world.x / uDepthRatio, uHorizon - (world.y - uRestHeight) / uDepthRatio);
    }
`

const backdropVertex = /* glsl */ `
    ${restPixel}
    varying vec2 vPixel;

    void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vPixel = restPixel(world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
    }
`

// The far void and the horizon key light. Nothing here moves with the camera
export const skyShader = {
    vertexShader: backdropVertex,
    fragmentShader: /* glsl */ `
        uniform vec2 uSize;
        uniform float uHorizon;
        uniform float uTime;
        varying vec2 vPixel;

        ${dither}
        ${noise}

        void main() {
            vec2 p = vPixel / uSize;
            float toHorizon = clamp(vPixel.y / uHorizon, 0.0, 1.0);

            // A near black void that turns deep navy only close to the horizon
            vec3 color = mix(vec3(0.008, 0.016, 0.047), vec3(0.016, 0.02, 0.102), smoothstep(0.4, 1.0, toHorizon));

            // Key light: one cyan glow along the horizon, strongest under the conductor, breathing slowly
            float above = max(uHorizon - vPixel.y, 0.0) / uSize.y;
            float spread = 0.3 + 0.7 * exp(-pow((p.x - 0.62) / 0.5, 2.0));
            float breathe = 1.0 + 0.07 * sin(uTime * 0.45);
            float glow = 0.38 * exp(-above / 0.0075) + 0.2 * exp(-above / 0.035) + 0.07 * exp(-above / 0.14);
            vec3 light = mix(vec3(0.275, 0.89, 0.937), vec3(0.8, 0.98, 1.0), 0.35 * exp(-above / 0.004));
            color += light * glow * spread * breathe;

            // Horizon mist: a soft band of long wisps lying along the horizon, just above the key light so it
            // reads against the dark. The wisps drift slowly sideways, and the noise that bends them turns
            // over with time, so they change shape as they go. Cyan in the key light under the conductor,
            // violet away from it and toward the top of the band. The water mirrors them faintly
            float lift = (uHorizon - vPixel.y) / uSize.y;
            float band = exp(-pow((lift - 0.03) / 0.026, 2.0)) * smoothstep(-0.002, 0.006, lift);
            if (band > 0.01) {
                vec2 q = vec2(vPixel.x / (uSize.y * 0.5) + uTime * 0.012, lift * 38.0);
                vec2 bendBy = vec2(fbm(q * 0.6 + vec2(3.1, uTime * 0.035)), fbm(q * 0.45 + vec2(7.7, -uTime * 0.028)));
                float wisps = smoothstep(0.42, 0.78, fbm(q + (bendBy - 0.5) * vec2(1.8, 1.2)));
                float violetShare = clamp(smoothstep(0.06, 0.38, abs(p.x - 0.62)) + smoothstep(0.03, 0.07, lift) * 0.35, 0.0, 1.0);
                vec3 tint = mix(vec3(0.4, 0.86, 0.95), vec3(0.62, 0.48, 1.0), violetShare);
                color += tint * band * (0.03 + 0.3 * wisps) * (0.62 + 0.38 * spread);
            }

            gl_FragColor = vec4(dithered(color), 1.0);
        }
    `,
}

// The nearer veil layer: the violet nebula and the diagonal ribbon. Added over the void,
// seen by the water, and nearer than the stars so it moves a little more with the camera
export const veilShader = {
    vertexShader: backdropVertex,
    fragmentShader: /* glsl */ `
        uniform vec2 uSize;
        uniform float uTime;
        // Messages on the thread: where each one is as a share of the hero width, and how bright
        uniform vec3 uPulseAlong;
        uniform vec3 uPulseStrength;
        varying vec2 vPixel;

        ${dither}
        ${noise}

        // Same falloff as a CSS radial gradient that fades to transparent at the given stop
        float cssBlob(vec2 pixel, vec2 center, vec2 radius, float stop) {
            vec2 d = (pixel - center * uSize) / (radius * uSize);
            return clamp(1.0 - length(d) / stop, 0.0, 1.0);
        }

        // Where a pixel falls along a gradient axis given in hero fractions
        float along(vec2 pixel, vec2 from, vec2 to) {
            vec2 a = from * uSize;
            vec2 axis = to * uSize - a;
            return clamp(dot(pixel - a, axis) / dot(axis, axis), 0.0, 1.0);
        }

        // The ribbon's leading edge in hero fractions: low and flat at the left, climbing to the upper right
        float ribbonEdge(float x, float t) {
            float k = max(x, 0.0);
            return 0.6 - 0.05 * x - 0.5 * pow(k, 2.4) + 0.014 * sin(t * 0.075 + x * 2.2) * x;
        }

        // Color and opacity ramps of the ribbon along its length: faint where it leaves the horizon,
        // blue through the open sky beside the title, violet at the top right
        vec4 veilRamp(float g) {
            vec4 c = mix(vec4(0.07, 0.2, 0.33, 0.06), vec4(0.09, 0.2, 0.4, 0.22), smoothstep(0.0, 0.25, g));
            c = mix(c, vec4(0.145, 0.243, 0.58, 0.5), smoothstep(0.25, 0.55, g));
            return mix(c, vec4(0.227, 0.133, 0.463, 0.36), smoothstep(0.55, 1.0, g));
        }

        vec4 foldRamp(float g) {
            vec4 c = mix(vec4(0.11, 0.32, 0.49, 0.04), vec4(0.19, 0.37, 0.63, 0.28), smoothstep(0.0, 0.5, g));
            return mix(c, vec4(0.337, 0.22, 0.63, 0.2), smoothstep(0.5, 1.0, g));
        }

        vec4 threadRamp(float g) {
            vec4 c = mix(vec4(0.13, 0.23, 0.42, 0.0), vec4(0.15, 0.41, 0.64, 0.12), smoothstep(0.2, 0.34, g));
            c = mix(c, vec4(0.33, 0.81, 0.94, 0.7), smoothstep(0.34, 0.44, g));
            c = mix(c, vec4(0.41, 0.87, 0.93, 0.8), smoothstep(0.44, 0.54, g));
            c = mix(c, vec4(0.19, 0.29, 0.51, 0.25), smoothstep(0.54, 0.7, g));
            return mix(c, vec4(0.27, 0.19, 0.5, 0.05), smoothstep(0.7, 1.0, g));
        }

        void main() {
            vec2 p = vPixel / uSize;
            vec3 color = vec3(0.0);

            // Violet nebula upper right behind the conductor, kept quiet so the dome and ribbon read
            float drift = uTime * 0.004;
            float cloudA = fbm(vPixel / 260.0 + vec2(drift, 0.0));
            float cloudB = fbm(vPixel / 90.0 - vec2(drift * 0.6, drift * 0.3));
            float cloud = 0.2 + 1.4 * cloudA + 0.6 * (cloudB - 0.5);
            float nebula = 0.5 * cssBlob(vPixel, vec2(0.74, 0.30), vec2(0.36, 0.38), 0.76) * cloud;
            nebula += 0.28 * cssBlob(vPixel, vec2(0.86, 0.14), vec2(0.22, 0.2), 0.7) * cloud;
            nebula += 0.12 * cssBlob(vPixel, vec2(0.58, 0.48), vec2(0.2, 0.16), 0.7) * cloud;
            vec3 violet = mix(vec3(0.647, 0.486, 1.0), vec3(0.36, 0.42, 0.95), clamp(cloudB, 0.0, 1.0));
            color += violet * clamp(nebula, 0.0, 0.6) * 0.42;

            // A faint blue haze lower left, so the title does not float in a void
            float haze = 0.06 * cssBlob(vPixel, vec2(0.2, 0.58), vec2(0.32, 0.3), 0.75) * (0.7 + 0.6 * cloudA);
            color += vec3(0.24, 0.44, 0.8) * haze;

            // The ribbon: layered folds hanging from one leading edge, blue low and violet high,
            // with a cyan thread along the edge. Creases and ridges travel slowly along it
            float t = uTime;
            float scale = max(uSize.x / 1600.0, uSize.y / 1000.0);
            float edge = ribbonEdge(p.x, t);
            float rise = (ribbonEdge(p.x + 0.002, t) - ribbonEdge(p.x - 0.002, t)) / 0.004 * uSize.y / uSize.x;
            float across = (vPixel.y - edge * uSize.y) / sqrt(1.0 + rise * rise);
            float u = clamp((p.x + 0.06) / 1.1, 0.0, 1.0);
            float envelope = sin(u * 1.5707963);
            float crease = (sin(u * 29.0 + t * 0.055) * 5.0 + sin(u * 73.0 - t * 0.035) * 2.2) * envelope * scale;

            float g = along(vPixel, vec2(0.05, 0.6), vec2(0.97, 0.02));
            vec4 veilColor = veilRamp(g);
            vec4 foldColor = foldRamp(g);
            vec4 threadColor = threadRamp(g);

            float spreads[5];
            spreads[0] = 150.0;
            spreads[1] = 91.0;
            spreads[2] = 53.0;
            spreads[3] = 32.0;
            spreads[4] = 18.0;
            float soft = 1.8 * scale;
            vec3 ribbon = vec3(0.0);
            float threadA = 0.0;
            float threadB = 0.0;
            float leading = 0.0;
            for (int i = 0; i < 5; i++) {
                float fi = float(i);
                float spread = spreads[i] * scale;
                float ridge = sin(u * 11.0 + fi * 0.6 + t * 0.08) * spread * 0.16 * envelope;
                float outer = crease + ridge;
                float inner = outer + spread * envelope * (0.65 + 0.35 * pow(sin(u * 7.0 + fi * 0.45), 2.0));
                float band = smoothstep(outer - soft, outer + soft, across) * (1.0 - smoothstep(inner - soft * 4.0, inner + soft, across));
                vec4 tone = i < 2 ? veilColor * vec4(1.0, 1.0, 1.0, 0.28 - fi * 0.05) : foldColor * vec4(1.0, 1.0, 1.0, 0.55 - fi * 0.04);
                ribbon += tone.rgb * tone.a * band;
                if (i == 0) {
                    threadA = exp(-pow((across - outer) / (1.4 * scale + 0.9), 2.0));
                    leading = outer;
                }
                if (i == 3) threadB = exp(-pow((across - outer) / (0.6 * scale + 0.7), 2.0));
            }
            ribbon += threadColor.rgb * threadColor.a * (threadA * 0.9 + threadB * 0.45);
            color += ribbon * 1.2;

            // Messages: a bright bead in a small round glow with a fading trail, running along the thread toward the conductor
            float side = (across - leading) / scale;
            float onThread = exp(-pow((across - leading) / (1.5 * scale + 0.8), 2.0));
            float trail = 0.0;
            float bead = 0.0;
            for (int k = 0; k < 3; k++) {
                float behind = (uPulseAlong[k] * uSize.x - vPixel.x) / scale;
                trail += uPulseStrength[k] * (behind > 0.0 ? exp(-behind / 110.0) : 0.0);
                bead += uPulseStrength[k] * (exp(-(behind * behind + side * side * 4.0) / 30.0) + 0.3 * exp(-(behind * behind + side * side) / 260.0));
            }
            color += vec3(0.5, 0.95, 1.0) * trail * onThread * 0.7 + vec3(0.72, 0.98, 1.0) * bead * 1.3;

            gl_FragColor = vec4(dithered(color), 1.0);
        }
    `,
}

// The glass dome. Each pane draws its sheen, its side of the three struts around it and its
// share of the hubs at its corners, so neighbors join into whole lines and dots
export const domeShader = {
    vertexShader: /* glsl */ `
        attribute vec3 aBary;
        attribute vec3 aHeights;
        attribute vec4 aCornersAB;
        attribute vec4 aCornerC;
        attribute vec3 aPrimary;
        attribute vec3 aMajor;
        attribute vec4 aSheen;
        uniform float uHalfWidth;
        uniform float uHorizon;
        uniform float uGlintTime;
        uniform float uGlintStep;
        uniform float uGlintPulse;
        varying vec2 vPixel;
        varying vec3 vBary;
        varying vec3 vHeights;
        varying vec4 vCornersAB;
        varying vec2 vCornerC;
        varying vec3 vPrimary;
        varying vec3 vMajor;
        varying vec4 vSheen;
        varying float vSheenCorner;
        varying float vGlint;

        void main() {
            vPixel = vec2(position.x + uHalfWidth, uHorizon - position.y);
            vBary = aBary;
            vHeights = aHeights;
            vCornersAB = aCornersAB;
            vCornerC = aCornerC.xy;
            vPrimary = aPrimary;
            vMajor = aMajor;
            vSheen = aSheen;
            vSheenCorner = aCornerC.w;

            // Panes on the glint path light up in turn: a quick rise, a slower fade
            float glint = 0.0;
            if (aCornerC.z >= 0.0) {
                float local = uGlintTime - aCornerC.z * uGlintStep;
                float peak = uGlintPulse * 0.32;
                if (local > 0.0 && local < uGlintPulse) {
                    glint = local < peak ? smoothstep(0.0, 1.0, local / peak) : 1.0 - smoothstep(0.0, 1.0, (local - peak) / (uGlintPulse - peak));
                }
            }
            vGlint = glint;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform float uFadeTop;
        uniform float uFadeBottom;
        varying vec2 vPixel;
        varying vec3 vBary;
        varying vec3 vHeights;
        varying vec4 vCornersAB;
        varying vec2 vCornerC;
        varying vec3 vPrimary;
        varying vec3 vMajor;
        varying vec4 vSheen;
        varying float vSheenCorner;
        varying float vGlint;

        float max3(vec3 v) {
            return max(max(v.x, v.y), v.z);
        }

        void main() {
            // The dome thins out well above the horizon and never reaches the water
            float fade = 1.0 - smoothstep(uFadeTop, uFadeBottom, vPixel.y);
            if (fade <= 0.0) discard;
            // One device pixel in CSS pixels, for smooth edges at any pixel ratio
            float aa = max(length(fwidth(vPixel)) * 0.6, 0.3);

            // Struts: distance to each edge from the barycentric weights
            vec3 edge = vBary * vHeights;
            vec3 halfWidth = mix(vec3(0.42), vec3(0.65), vPrimary);
            vec3 line = 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, edge);
            float minor = max3(line * (1.0 - vPrimary)) * 0.055;
            float primaryLine = max3(line * vPrimary) * 0.09;
            vec3 color = vec3(0.663, 0.796, 1.0) * minor + vec3(0.788, 0.871, 1.0) * primaryLine;

            // Hubs: small beads on every joint, the five way hubs a little brighter with a halo
            vec3 toCorner = vec3(distance(vPixel, vCornersAB.xy), distance(vPixel, vCornersAB.zw), distance(vPixel, vCornerC));
            vec3 radius = mix(vec3(0.85), vec3(2.0), vMajor);
            float hub = max3((1.0 - smoothstep(radius - aa, radius + aa, toCorner)) * mix(vec3(0.1), vec3(0.3), vMajor));
            float halo = max3(vMajor * (1.0 - smoothstep(0.0, 7.0, toCorner))) * 0.035;
            color += vec3(0.863, 0.922, 1.0) * hub + vec3(0.737, 0.843, 1.0) * halo;

            // Sheen: light caught from one corner, gone before it crosses the pane
            float fromCorner = vSheenCorner < 0.5 ? vBary.x : (vSheenCorner < 1.5 ? vBary.y : vBary.z);
            color += vSheen.rgb * vSheen.a * smoothstep(0.3, 1.0, fromCorner);

            // Glint: the lit pane fills from its corner and its rim catches the light
            if (vGlint > 0.0) {
                float fill = mix(0.0, 0.12, smoothstep(0.0, 0.45, fromCorner)) + 0.38 * smoothstep(0.45, 1.0, fromCorner);
                float rim = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, min(min(edge.x, edge.y), edge.z));
                color += (vec3(0.902, 0.945, 1.0) * fill + vec3(0.863, 0.922, 1.0) * rim) * vGlint * 0.26;
            }

            gl_FragColor = vec4(color * fade, 1.0);
        }
    `,
}

export const starShader = {
    vertexShader: /* glsl */ `
        attribute float aRadius;
        attribute float aAlpha;
        attribute float aPhase;
        uniform float uPixelRatio;
        uniform float uTime;
        uniform float uTwinkle;
        varying float vAlpha;
        varying float vRadius;

        void main() {
            // Each star on its own slow beat, never quicker than about seven seconds
            float twinkle = 1.0 + uTwinkle * 0.16 * sin(uTime * (0.32 + fract(aPhase * 7.13) * 0.55) + aPhase);
            vAlpha = aAlpha * twinkle;
            vRadius = aRadius;
            // Room for a soft edge, and for the faint halo on the brightest stars
            gl_PointSize = (aRadius > 1.3 ? aRadius * 8.0 : aRadius * 2.0 + 3.0) * uPixelRatio;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform float uPixelRatio;
        varying float vAlpha;
        varying float vRadius;

        void main() {
            float size = vRadius > 1.3 ? vRadius * 8.0 : vRadius * 2.0 + 3.0;
            float d = length(gl_PointCoord - 0.5) * size;
            float core = 1.0 - smoothstep(vRadius - 0.6, vRadius + 0.6, d);
            float halo = vRadius > 1.3 ? 0.3 * (1.0 - smoothstep(0.0, vRadius * 4.0, d)) : 0.0;
            float a = vAlpha * max(core, halo);
            gl_FragColor = vec4(vec3(0.933, 0.941, 1.0) * a, a);
        }
    `,
}

// The conductor's twin. It only renders into the water reflection, the crisp conductor is the DOM image
export const twinShader = {
    vertexShader: /* glsl */ `
        varying vec2 vUv;

        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform sampler2D uWaves;
        uniform float uGlow;
        varying vec2 vUv;

        void main() {
            // Both textures are premultiplied on upload
            vec4 art = texture2D(uMap, vUv, -0.5);
            vec4 waves = texture2D(uWaves, vUv);
            vec3 color = art.rgb + waves.rgb * uGlow * 0.7;
            gl_FragColor = vec4(color, art.a);
        }
    `,
}

// A companion object. Distance thins its color toward the night between it and the viewer
export const companionShader = {
    vertexShader: /* glsl */ `
        varying vec2 vUv;

        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uHaze;
        uniform float uOpacity;
        // Above 1 while it notices the pointer
        uniform float uLift;
        varying vec2 vUv;

        void main() {
            // Premultiplied on upload
            vec4 art = texture2D(uMap, vUv);
            vec3 color = mix(art.rgb, vec3(0.05, 0.08, 0.2) * art.a, uHaze) * uLift;
            gl_FragColor = vec4(color, art.a) * uOpacity;
        }
    `,
}

export const waterShader = {
    name: "FluxerlyWater",
    uniforms: {
        color: { value: null },
        tDiffuse: { value: null },
        textureMatrix: { value: null },
        uTime: { value: 0 },
        uSize: { value: null },
        uPixelRatio: { value: 1 },
        uHorizon: { value: 0 },
        uFocal: { value: 1 },
        uTexel: { value: null },
        uDip: { value: 0 },
        uRing: { value: null },
    },
    vertexShader: /* glsl */ `
        uniform mat4 textureMatrix;
        varying vec4 vUv;
        varying vec3 vWorld;

        void main() {
            vUv = textureMatrix * vec4(position, 1.0);
            vec4 world = modelMatrix * vec4(position, 1.0);
            vWorld = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
        }
    `,
    fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform vec2 uSize;
        uniform float uPixelRatio;
        uniform float uHorizon;
        uniform float uFocal;
        uniform vec2 uTexel;
        // How far the viewer has sunk toward the surface, from 0 to 1
        uniform float uDip;
        // The ring a message leaves under the conductor: its center on the water, its radius in world
        // units, and its strength
        uniform vec4 uRing;
        varying vec4 vUv;
        varying vec3 vWorld;

        ${dither}

        const vec3 cyan = vec3(0.275, 0.89, 0.937);
        const float keyX = 0.62;

        // One directional wave's slope. Waves shorter than about two pixels fade out so the far water does not shimmer.
        // wave: direction angle from the view axis, wavelength in world units, slope strength
        vec2 waveSlope(vec2 p, float t, vec3 wave, float phase, float footprint) {
            vec2 dir = vec2(sin(wave.x), cos(wave.x));
            float k = 6.2831853 / wave.y;
            float speed = sqrt(20.5 * k);
            float fade = 1.0 - smoothstep(0.22, 0.5, footprint / wave.y);
            return dir * wave.z * fade * cos(dot(dir, p) * k + t * speed + phase);
        }

        // Short ripples
        vec2 rippleSlope(vec2 p, float t, float footprint) {
            vec2 slope = waveSlope(p, t, vec3(0.10, 11.0, 0.012), 0.0, footprint);
            slope += waveSlope(p, t, vec3(-0.38, 17.0, 0.02), 1.7, footprint);
            slope += waveSlope(p, t, vec3(0.52, 26.0, 0.030), 3.4, footprint);
            slope += waveSlope(p, t, vec3(-0.21, 41.0, 0.034), 5.1, footprint);
            slope += waveSlope(p, t, vec3(0.86, 67.0, 0.022), 6.8, footprint);
            slope += waveSlope(p, t, vec3(-0.64, 103.0, 0.020), 8.5, footprint);
            return slope;
        }

        // Long slow swells under the ripples
        vec2 swellSlope(vec2 p, float t, float footprint) {
            vec2 slope = waveSlope(p, t, vec3(0.18, 340.0, 0.03), 0.4, footprint);
            slope += waveSlope(p, t, vec3(-0.42, 560.0, 0.028), 2.1, footprint);
            slope += waveSlope(p, t, vec3(0.75, 900.0, 0.02), 4.4, footprint);
            return slope;
        }

        void main() {
            vec2 pixel = vec2(gl_FragCoord.x, uSize.y * uPixelRatio - gl_FragCoord.y) / uPixelRatio;
            float below = max(pixel.y - uHorizon, 0.0);
            float depth = clamp(below / (uSize.y - uHorizon), 0.0, 1.0);
            float px = pixel.x / uSize.x;
            float footprint = length(fwidth(vWorld.xz));

            vec2 ripple = rippleSlope(vWorld.xz, uTime, footprint);
            vec2 swell = swellSlope(vWorld.xz, uTime, footprint);

            // Contact ring: one soft ring spreading on the water under the conductor when a message
            // arrives. Measured on the water itself, so it opens in perspective. Crest leading outward,
            // trough behind it, never thinner than the pixels can hold
            float ring = 0.0;
            if (uRing.w > 0.0) {
                float width = max(7.0 + uRing.z * 0.08, footprint * 1.6);
                float x = (distance(vWorld.xz, uRing.xy) - uRing.z) / width;
                ring = 2.33 * x * exp(-x * x) * uRing.w;
            }

            // Reflection: projected lookup, nudged by ripples, swells and the ring, softened with a short vertical blur
            vec2 bend = ripple + swell * 0.6;
            vec2 uv = vUv.xy / vUv.w + vec2(bend.x * 0.04, bend.y * 0.075 + ring * 0.012);
            vec3 reflection = vec3(0.0);
            float total = 0.0;
            for (int i = -4; i <= 4; i++) {
                float w = exp(-float(i * i) / 8.0);
                reflection += texture2D(tDiffuse, uv + vec2(0.0, float(i) * uTexel.y * 1.6)).rgb * w;
                total += w;
            }
            reflection /= total;

            // Water mirrors more at grazing angles near the horizon, less when looking down.
            // Sinking toward the surface makes every angle more grazing
            float mirror = mix(0.52, 0.22, pow(depth, 0.75));
            mirror += (0.74 - mirror) * uDip * 0.6;
            vec3 deep = mix(vec3(0.03, 0.047, 0.16), vec3(0.012, 0.016, 0.075), smoothstep(0.0, 1.0, depth));
            vec3 color = deep * (1.0 - mirror * 0.5) + reflection * vec3(0.9, 0.94, 1.0) * mirror;

            // Swells: the flank that tips toward the horizon catches its light, so broad bands drift past
            float spread = 0.35 + 0.65 * exp(-pow((px - keyX) / 0.42, 2.0));
            float band = clamp(swell.y * 22.0, -1.0, 1.0);
            float reach = smoothstep(0.0, 0.05, depth) * (1.0 - smoothstep(0.3, 0.85, depth));
            color += vec3(0.16, 0.42, 0.62) * max(band, 0.0) * reach * spread * 0.24;
            color *= 1.0 - 0.14 * max(-band, 0.0) * reach;

            // Light path: the horizon key light reaches toward the viewer on facets tipped just right,
            // so the ripples break it into a column of glitter
            vec2 slope = ripple + swell;
            vec2 need = vec2((pixel.x - keyX * uSize.x) * 0.5, below * 0.3) / uFocal;
            vec2 miss = (slope - need) / 0.036;
            float glitter = exp(-dot(miss, miss));
            float column = exp(-pow((px - keyX) / (0.05 + 0.16 * depth), 2.0));
            float closeBy = exp(-depth / 0.3);
            color += cyan * column * closeBy * 0.055;
            color += vec3(0.62, 0.95, 1.0) * glitter * column * exp(-depth / 0.45) * 0.6;

            // Sparse soft glints along the far water, each fading in and out on its own slow beat
            vec2 cellSize = vec2(15.0, 2.6 + below * 0.06);
            vec2 cell = vec2(pixel.x, below) / cellSize;
            vec2 id = floor(cell);
            vec2 f = fract(cell) - 0.5;
            float seed = hash12(id + 17.0);
            float beat = 0.5 + 0.5 * sin(uTime * (0.34 + seed * 0.6) + seed * 60.0);
            float spot = exp(-(f.x * f.x * 14.0 + f.y * f.y * 10.0));
            float sparkle = step(0.93, seed) * spot * beat * beat * beat * (1.0 - smoothstep(0.02, 0.16, depth)) * (0.3 + 0.7 * spread);
            color += vec3(0.7, 0.96, 1.0) * sparkle * 0.5;

            // The ring's crest catches the key light, its trough falls a little darker
            color += vec3(0.55, 0.93, 1.0) * max(ring, 0.0) * 0.26;
            color *= 1.0 - 0.2 * max(-ring, 0.0);

            // The foreground water settles into darkness
            color *= 1.0 - 0.3 * smoothstep(0.5, 1.0, depth);

            gl_FragColor = vec4(dithered(color), 1.0);
        }
    `,
}

// Fine dust in the sky: specks at two depths drifting slowly toward the conductor's side, wrapping
// around the hero. Everything moves in the shader from the scene time, so the points never change
export const dustShader = {
    vertexShader: /* glsl */ `
        // Rest place as shares of the hero box, depth ratio, and a seed from 0 to 1
        attribute vec4 aDust;
        uniform vec2 uSize;
        uniform float uHalfWidth;
        uniform float uHorizon;
        uniform float uRestHeight;
        uniform float uFocal;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vAlpha;
        varying vec3 vTint;

        void main() {
            float seed = aDust.w;
            float ratio = aDust.z;
            float near = step(ratio, 2.5);
            // Pixels per second, slower than any companion
            float speed = mix(1.1, 2.6, near) * (0.75 + 0.5 * seed);
            float span = uSize.x + 60.0;
            float x = mod(aDust.x * span + uTime * speed, span) - 30.0;
            float y = aDust.y * uSize.y + 5.0 * sin(uTime * (0.16 + 0.2 * seed) + seed * 37.0);
            // Thin out toward the horizon light and under the header
            float fade = (1.0 - smoothstep(uHorizon - 0.12 * uSize.y, uHorizon - 0.03 * uSize.y, y)) * smoothstep(0.05 * uSize.y, 0.12 * uSize.y, y);
            float shimmer = 0.65 + 0.35 * sin(uTime * (0.3 + 0.35 * fract(seed * 7.7)) + seed * 51.0);
            vAlpha = (mix(0.12, 0.22, near) + 0.1 * fract(seed * 3.3)) * fade * shimmer;
            vTint = mix(vec3(0.72, 0.93, 1.0), vec3(0.82, 0.76, 1.0), fract(seed * 5.1));
            vec3 world = vec3((x - uHalfWidth) * ratio, uRestHeight + (uHorizon - y) * ratio, -uFocal * ratio);
            gl_PointSize = mix(2.6, 3.4, near) * uPixelRatio;
            gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vTint;

        void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            gl_FragColor = vec4(vTint * vAlpha * (1.0 - smoothstep(0.15, 1.0, d)), 1.0);
        }
    `,
}

// A shooting star: a bright head with a short trail that thins and cools toward its tail. The quad
// runs from the tail to just past the head, in pixels at the star's own depth
export const shootingStarShader = {
    vertexShader: /* glsl */ `
        varying vec2 vUv;

        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform float uLength;
        uniform float uReach;
        uniform float uHalf;
        uniform float uAlpha;
        varying vec2 vUv;

        void main() {
            float x = vUv.x * uReach;
            float y = (vUv.y - 0.5) * 2.0 * uHalf;
            float along = clamp(x / uLength, 0.0, 1.0);
            float width = 0.8 + 1.1 * along;
            float trail = along * along * exp(-(y * y) / (width * width)) * step(x, uLength);
            float hx = x - uLength;
            float r2 = hx * hx + y * y;
            float head = exp(-r2 / 2.4) + 0.3 * exp(-r2 / 36.0);
            vec3 color = mix(vec3(0.5, 0.42, 0.95), vec3(0.7, 0.95, 1.0), along) * trail + vec3(0.92, 0.98, 1.0) * head;
            gl_FragColor = vec4(color * uAlpha, 1.0);
        }
    `,
}

// The conductor's face glass, drawn in the pixels of the 2048 canvas with its y going down, the way the PSD stacks it: far
// space, the mist, the black hole's far arm and lens, its disk and teal arm, its near arm, the eyes, the brows, the waves, the
// crescents and the light on the glass. Everything that isn't the painting is scaled by uWake, so at 0 this is the painting.
//
// The black hole is what the eye reads as gravity: what lies behind it streams inward and bends around it, its far side's light
// arcs over the top of the void, clumps of hot matter wind around and into it, dust spirals down and goes out at the horizon
// and the ring burns brightest on the side coming toward the viewer
const facePartRect = (name: keyof typeof faceArt.parts) => {
    const { left, top, width, height } = faceArt.parts[name]
    return `vec4(${left}.0, ${top}.0, ${width}.0, ${height}.0)`
}

export const faceShader = {
    vertexShader: /* glsl */ `
        varying vec2 vUv;

        void main() {
            vUv = vec2(uv.x, 1.0 - uv.y);
            gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform sampler2D uFar, uMist, uLens, uFlow, uViolet, uEyes, uBrows, uWaves, uWavesLight, uCrescents, uSheen, uGlass;
        uniform float uTime, uWake, uGlow;
        uniform vec4 uEye[2];
        uniform vec4 uBrow[2];
        uniform vec4 uCheek[2];
        uniform vec2 uGaze, uView, uCharge;
        varying vec2 vUv;

        const vec4 glassBox = ${facePartRect("glass")};
        const vec4 mistBox = ${facePartRect("mist")};
        const vec4 farBox = ${facePartRect("far")};
        const vec4 holeBox = ${facePartRect("lens")};
        const vec4 eyesBox = ${facePartRect("eyes")};
        const vec4 browsBox = ${facePartRect("brows")};
        const vec4 wavesBox = ${facePartRect("waves")};
        const vec4 crescentsBox = ${facePartRect("crescents")};
        const vec4 sheenBox = ${facePartRect("sheen")};

        // The void, from the PSD: its center and radius. The disk's center and its plane, tilted as painted and seen nearly edge on
        const vec2 hole = vec2(1050.0, 1466.5);
        const float horizon = 82.0;
        const vec2 diskCenter = vec2(1062.0, 1473.0);
        const float diskTilt = 0.14;
        const float diskFlat = 0.33;
        // Where the face's parts hinge: each eye's middle, each brow's, each crescent's. Between the strokes of the waves
        const vec2 eyeCenter0 = vec2(761.5, 1080.5);
        const vec2 eyeCenter1 = vec2(1268.5, 1056.5);
        const vec2 browCenter0 = vec2(761.0, 930.0);
        const vec2 browCenter1 = vec2(1269.0, 909.0);
        const vec2 cheekCenter0 = vec2(684.0, 1271.0);
        const vec2 cheekCenter1 = vec2(1364.0, 1271.0);
        const float faceSplit = 1014.0;
        const float cheekSplit = 1024.0;
        const float wavesSplit = 1197.0;

        const vec3 cyan = vec3(0.36, 0.92, 1.0);
        const vec3 violet = vec3(0.62, 0.42, 1.0);
        const float tau = 6.28318530718;

        float hash(float n) {
            return fract(sin(n * 12.9898) * 43758.5453);
        }

        mat2 turn(float a) {
            float c = cos(a), s = sin(a);
            return mat2(c, -s, s, c);
        }

        // A part at a point of the canvas, with nothing outside its box
        vec4 part(sampler2D map, vec4 box, vec2 at, float bias) {
            vec2 uv = (at - box.xy) / box.zw;
            vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
            return texture2D(map, uv, bias) * inside.x * inside.y;
        }

        vec4 over(vec4 under, vec4 top) {
            return top + under * (1.0 - top.a);
        }

        // Clumps of matter on a spiral: around the angle and in along the log of the radius. They only ever move on, angle and
        // radius falling with time, which on the near side of this disk is left to right
        float clumps(float angle, float logRadius, float speed) {
            float big = 0.5 + 0.5 * sin(3.0 * angle + 7.0 * logRadius + uTime * speed + 1.6 * sin(2.0 * angle + 4.0 * logRadius + uTime * 0.37));
            float fine = 0.5 + 0.5 * sin(8.0 * angle + 17.0 * logRadius + uTime * speed * 1.7 + 2.1);
            return big * big * (0.45 + 0.55 * fine);
        }

        void main() {
            vec2 p = glassBox.xy + vUv * glassBox.zw;
            float wake = uWake;
            float t = uTime;

            vec2 fromHole = p - hole;
            float radius = length(fromHole);
            vec2 outward = fromHole / max(radius, 1.0);
            float holeAngle = atan(fromHole.y, fromHole.x);

            // The viewer's place moves the depths against each other: far space the most, as through a window
            vec2 view = uView * wake;

            // Space falls in. What lies near the hole streams toward it and winds around it, seen as two copies a half cycle
            // apart, each fading out before it would have come too far. Lens: only the part close by, and none at rest
            float pull = smoothstep(330.0, 95.0, radius) * wake;
            float stream = t / 7.0;
            float cycleA = fract(stream);
            float cycleB = fract(stream + 0.5);
            float weightA = 1.0 - abs(2.0 * cycleA - 1.0);
            vec2 fall = outward * 74.0 * pull;
            float wind = 0.95 * pull;
            vec2 farA = hole + turn((cycleA - 0.5) * wind) * (fromHole + fall * (cycleA - 0.5));
            vec2 farB = hole + turn((cycleB - 0.5) * wind) * (fromHole + fall * (cycleB - 0.5));
            // A still bend on top of that, as light passing a mass: the sky beside the horizon comes from further out
            vec2 bend = outward * pull * 2600.0 / max(radius, horizon);
            vec2 window = view * vec2(-13.0, -9.0);
            vec4 far = mix(part(uFar, farBox, farB + bend + window, -0.25), part(uFar, farBox, farA + bend + window, -0.25), weightA);

            // Stars breathe: what stands out from its surroundings gets brighter and dimmer on its own beat
            vec3 surroundings = part(uFar, farBox, p + bend + window, 3.5).rgb;
            float standout = smoothstep(0.08, 0.34, max(max(far.r, far.g), far.b) - max(max(surroundings.r, surroundings.g), surroundings.b));
            vec2 starCell = floor(p / 40.0);
            float starSeed = hash(starCell.x * 7.0 + starCell.y * 113.0);
            far.rgb = mix(far.rgb, far.rgb * (0.82 + 0.5 * sin(t * (0.8 + 1.8 * starSeed) + starSeed * tau)), standout * wake);
            vec4 color = far;

            // The galaxy's soft light turns slowly around the middle of the glass, bending as far space does
            vec2 mistAt = (p + bend * 0.6 + view * vec2(-7.0, -5.0)) - (mistBox.xy + mistBox.zw * 0.5);
            vec4 mist = part(uMist, mistBox, turn(t * tau / 90.0) * mistAt + mistBox.xy + mistBox.zw * 0.5, 0.0);
            color = over(color, mist * 0.5 * wake);

            // The disk's plane: flat coordinates around its center
            vec2 flat2 = turn(-diskTilt) * (p - diskCenter);
            flat2.y /= diskFlat;
            float diskRadius = length(flat2);
            float diskAngle = atan(flat2.y, flat2.x);
            float diskLog = log(max(diskRadius, 8.0));
            float hotFlow = clumps(diskAngle, diskLog, 2.6);
            float side = 0.5 + 0.5 * cos(diskAngle - 3.4);
            vec3 hotColor = mix(violet, cyan, side);

            // The far side of the disk, behind the void. It passes round from the near side and lights up as it comes
            float farSide = smoothstep(14.0, -30.0, flat2.y);
            float annulus = smoothstep(104.0, 126.0, diskRadius) * smoothstep(232.0, 168.0, diskRadius);
            color.rgb += hotColor * farSide * annulus * (0.14 + 0.85 * hotFlow) * wake;

            // And its light bent up and over the top of the void, the sign of a black hole. A hair off the ring, thickest on top
            float over_top = smoothstep(0.35, -0.75, outward.y);
            float arc = smoothstep(11.0 + 5.0 * over_top, 0.0, abs(radius - (horizon + 9.0 + 7.0 * over_top + 1.6 * sin(holeAngle * 7.0 + t * 1.2))));
            float arcFlow = 0.42 + 0.58 * clumps(holeAngle, 0.0, 2.8);
            color.rgb += mix(violet, cyan, 0.5 - 0.5 * outward.x) * arc * over_top * arcFlow * 0.95 * wake;

            // The far arm and the lens as painted
            vec2 tailAt = p;
            float tailRight = smoothstep(150.0, 400.0, fromHole.x);
            tailAt.y += tailRight * (6.0 * sin(fromHole.x * 0.021 + t * 1.5) + 2.4 * sin(fromHole.x * 0.05 + t * 2.4)) * wake;
            color = over(color, part(uLens, holeBox, tailAt, -0.25));

            // Inside the horizon: the last light winds down into the middle and never comes out
            if (radius < horizon) {
                color.rgb *= mix(1.0, 0.42, smoothstep(horizon - 1.0, horizon - 9.0, radius) * wake);
                float depth = smoothstep(horizon - 2.0, horizon - 22.0, radius) * smoothstep(6.0, 34.0, radius);
                float veil = clumps(holeAngle, log(max(radius, 4.0)) * 1.3, 0.95);
                color.rgb += mix(vec3(0.1, 0.34, 0.72), vec3(0.34, 0.2, 0.74), side) * veil * depth * 0.3 * wake;
                color.rgb *= 1.0 - 0.75 * smoothstep(46.0, 8.0, radius) * wake;
            }

            // The ring: a hairline that burns, brightest on the side coming toward the viewer, with a bright knot that goes round
            float ring = smoothstep(7.5, 0.5, abs(radius - (horizon + 1.5)));
            float approaching = 0.32 + 0.68 * smoothstep(0.6, -0.8, outward.x);
            float knot = pow(0.5 + 0.5 * cos(holeAngle + t * 1.9), 10.0) + 0.6 * pow(0.5 + 0.5 * cos(holeAngle * 2.0 - t * 1.1 + 1.0), 14.0);
            color.rgb += mix(vec3(0.5, 0.42, 1.0), vec3(0.82, 1.0, 1.0), approaching) * ring * (0.08 + approaching * 0.24 + knot * 0.6) * wake;
            // A soft breath of light around it
            color.rgb += cyan * smoothstep(horizon + 46.0, horizon + 3.0, radius) * step(horizon, radius) * (0.045 + 0.03 * sin(t * 0.9)) * wake;

            // The disk and the teal arm, whose free end ripples as it comes. Hot matter runs through what is painted
            vec2 flowAt = p;
            float tailLeft = smoothstep(120.0, 400.0, -fromHole.x);
            flowAt.y += tailLeft * (9.0 * sin(fromHole.x * 0.017 + t * 1.25) + 3.2 * sin(fromHole.x * 0.043 + t * 2.1)) * wake;
            vec4 flow = part(uFlow, holeBox, flowAt, -0.25);
            // Round the hole it winds with the disk. Out on the arm it runs along the arm toward the hole, in long soft swells
            float armFlow = 0.5 + 0.5 * sin(fromHole.x * 0.021 - t * 2.1 + 1.8 * sin(fromHole.y * 0.024 + t * 0.47));
            float through = mix(hotFlow, armFlow * armFlow, tailLeft);
            flow.rgb *= 1.0 + (0.72 * through - 0.2) * wake;
            flow.rgb += flow.a * vec3(0.5, 0.9, 1.0) * pow(through, 3.0) * 0.32 * wake;
            color = over(color, flow);

            // The near side of the disk, coming round from behind the void and crossing in front of its lower part
            float nearSide = smoothstep(-14.0, 30.0, flat2.y);
            float nearBand = smoothstep(90.0, 108.0, diskRadius) * smoothstep(214.0, 150.0, diskRadius);
            color.rgb += hotColor * nearSide * nearBand * hotFlow * hotFlow * 0.8 * wake;

            // The near violet arm, its light running in toward the hole
            vec4 near = part(uViolet, holeBox, tailAt, -0.25);
            float violetFlow = 0.5 + 0.5 * sin(fromHole.x * 0.034 + t * 3.1 + 2.0 * sin(fromHole.y * 0.05 + t * 0.6));
            near.rgb *= 1.0 + (0.42 * violetFlow - 0.12) * wake;
            near.rgb += near.a * vec3(0.8, 0.66, 1.0) * pow(violetFlow, 4.0) * 0.2 * wake;
            color = over(color, near);

            // Dust spiraling down, each speck faster as it nears the horizon. It goes out there, or passes behind the void
            if (wake > 0.0 && abs(flat2.x) < 290.0 && abs(flat2.y) < 290.0) {
                vec3 dust = vec3(0.0);
                for (int i = 0; i < 26; i++) {
                    float k = float(i);
                    float seed = hash(k + 1.0);
                    float along = fract(t * (0.05 + 0.055 * hash(k + 17.0)) + seed * 7.0);
                    float closing = along * along;
                    float reach = mix(258.0, 86.0, closing);
                    float angle = seed * tau - closing * 7.4;
                    vec2 flatSpot = vec2(cos(angle), sin(angle)) * reach;
                    vec2 spot = turn(diskTilt) * vec2(flatSpot.x, flatSpot.y * diskFlat) + diskCenter;
                    float behind = step(flatSpot.y, 0.0) * step(length(spot - hole), horizon);
                    float size = mix(3.6, 1.8, closing) * (0.75 + 0.5 * hash(k + 31.0));
                    float speck = smoothstep(size, size * 0.2, length(p - spot));
                    float life = smoothstep(0.0, 0.12, along) * smoothstep(1.0, 0.92, along);
                    dust += mix(cyan, vec3(0.86, 0.8, 1.0), step(0.55, hash(k + 5.0))) * speck * life * (1.0 - behind);
                }
                color.rgb += dust * 1.35 * wake;
            }

            // The eyes: each moves, widens and closes around its own middle, with a soft light in it that follows the look
            vec2 eyeAt0 = eyeCenter0 + (p - eyeCenter0 - uEye[0].xy) / uEye[0].zw;
            vec2 eyeAt1 = eyeCenter1 + (p - eyeCenter1 - uEye[1].xy) / uEye[1].zw;
            vec4 eye0 = part(uEyes, eyesBox, eyeAt0, -0.25) * step(eyeAt0.x, faceSplit);
            vec4 eye1 = part(uEyes, eyesBox, eyeAt1, -0.25) * step(faceSplit, eyeAt1.x);
            vec2 glint0 = eyeCenter0 + vec2(-24.0, -34.0) + uGaze * vec2(26.0, 20.0);
            vec2 glint1 = eyeCenter1 + vec2(-24.0, -34.0) + uGaze * vec2(26.0, 20.0);
            eye0.rgb += eye0.a * smoothstep(40.0, 6.0, length(eyeAt0 - glint0)) * 0.2 * wake;
            eye1.rgb += eye1.a * smoothstep(40.0, 6.0, length(eyeAt1 - glint1)) * 0.2 * wake;
            color = over(over(color, eye0), eye1);

            // The brows are clouds: they lift and tip on their own, and their edges drift as cloud does
            vec2 cloudWobble = vec2(1.6 * sin(p.y * 0.09 + t * 0.8), 2.3 * sin(p.x * 0.05 + t * 1.05)) * wake;
            vec2 browAt0 = browCenter0 + turn(-uBrow[0].z) * (p - browCenter0 - uBrow[0].xy) + cloudWobble;
            vec2 browAt1 = browCenter1 + turn(-uBrow[1].z) * (p - browCenter1 - uBrow[1].xy) + cloudWobble;
            color = over(color, part(uBrows, browsBox, browAt0, -0.25) * step(browAt0.x, faceSplit));
            color = over(color, part(uBrows, browsBox, browAt1, -0.25) * step(faceSplit, browAt1.x));

            // The waves keep their painted shape. They are the conductor's charge: light fills each stroke from left to right, as a
            // battery fills, stays a moment and sinks back. It only ever brightens what is painted, its pale ribbons the most, and
            // the lower stroke fills a beat behind
            vec4 stroke1 = part(uWaves, wavesBox, p, -0.25) * step(wavesSplit, p.y);
            vec4 stroke0 = part(uWaves, wavesBox, p, -0.25) * step(p.y, wavesSplit);
            float along = (p.x - 878.0) / 270.0;
            float filled0 = smoothstep(0.14, -0.14, along - (uCharge.x * 1.5 - 0.25));
            float filled1 = smoothstep(0.14, -0.14, along - ((uCharge.x - 0.06) * 1.5 - 0.25));
            stroke0.rgb *= 1.0 + filled0 * uCharge.y * (0.22 + 0.55 * smoothstep(0.5, 0.92, stroke0.r / max(stroke0.a, 0.01)));
            stroke1.rgb *= 1.0 + filled1 * uCharge.y * (0.22 + 0.55 * smoothstep(0.5, 0.92, stroke1.r / max(stroke1.a, 0.01)));
            // Their soft light, which breathes, answers the pointer and rises with the charge: the strokes' own shape, far out of focus
            // Baked smooth, and ending in an oval well before the edge of its picture
            float waveLight = part(uWavesLight, wavesBox, p, 0.0).a * smoothstep(1.0, 0.55, length((p - vec2(1013.0, 1198.0)) / vec2(180.0, 155.0)));
            color.rgb += cyan * waveLight * (uGlow * 0.8 + (0.07 + 0.04 * sin(t * 0.85)) * wake + filled0 * uCharge.y * 0.34);
            color = over(over(color, stroke1), stroke0);

            // The crescents float and rock as small moons, each on its own, and a glint crosses their facets now and then
            vec2 cheekAt0 = cheekCenter0 + turn(-uCheek[0].z) * (p - cheekCenter0 - uCheek[0].xy);
            vec2 cheekAt1 = cheekCenter1 + turn(-uCheek[1].z) * (p - cheekCenter1 - uCheek[1].xy);
            vec4 cheek0 = part(uCrescents, crescentsBox, cheekAt0, -0.25) * step(cheekAt0.x, cheekSplit);
            vec4 cheek1 = part(uCrescents, crescentsBox, cheekAt1, -0.25) * step(cheekSplit, cheekAt1.x);
            float cross0 = (dot(cheekAt0 - cheekCenter0, vec2(0.7, 0.7)) / 56.0) - (fract(t / 6.5) * 9.0 - 3.0);
            float cross1 = (dot(cheekAt1 - cheekCenter1, vec2(-0.7, 0.7)) / 56.0) - (fract(t / 8.1 + 0.4) * 9.0 - 3.0);
            cheek0.rgb *= 1.0 + exp(-cross0 * cross0 * 5.0) * 0.8 * wake;
            cheek1.rgb *= 1.0 + exp(-cross1 * cross1 * 5.0) * 0.8 * wake;
            color = over(over(color, cheek0), cheek1);

            // The light on the glass stays on the glass, moving against everything behind it. Screen, as in the PSD
            vec4 sheen = part(uSheen, sheenBox, p + view * vec2(7.0, 5.0), 0.0);
            float sweep = fract(t / 11.0) * 3.4 - 1.2;
            float sweepAt = dot(vUv - 0.5, vec2(0.74, 0.5)) - sweep + 1.0;
            sheen.rgb *= 1.0 + 1.5 * exp(-sweepAt * sweepAt * 40.0) * wake;
            color.rgb += sheen.rgb * (1.0 - color.rgb);

            float glass = part(uGlass, glassBox, p, 0.0).a;
            gl_FragColor = color * glass;
        }
    `,
}
