import { faceArt } from "../lib/art"

// The conductor's face glass, drawn in the pixels of the 2048 canvas with its y going down, the way the PSD stacks it: far
// space, the mist, the black hole's far arm and lens, its disk and teal arm, its near arm, the eyes, the brows, the waves, the
// crescents and the light on the glass. Everything that isn't the painting is scaled by uWake, so at 0 this is the painting.
//
// The black hole is what the eye reads as gravity: what lies behind it streams inward and bends around it, its far side's light
// arcs over the top of the void, clumps of hot matter wind around and into it, dust spirals down and goes out at the horizon
// and the ring burns brightest on the side coming toward the viewer
//
// With HOLE_ONLY defined it draws the glass and its black hole alone, every other part as painted, for the conductor at the end of
// the page, whose eyes, brows, crescents and waves move as layers of their own over it, see src/scene/ending-face.ts
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
            #ifndef HOLE_ONLY
            vec3 surroundings = part(uFar, farBox, p + bend + window, 3.5).rgb;
            float standout = smoothstep(0.08, 0.34, max(max(far.r, far.g), far.b) - max(max(surroundings.r, surroundings.g), surroundings.b));
            vec2 starCell = floor(p / 40.0);
            float starSeed = hash(starCell.x * 7.0 + starCell.y * 113.0);
            far.rgb = mix(far.rgb, far.rgb * (0.82 + 0.5 * sin(t * (0.8 + 1.8 * starSeed) + starSeed * tau)), standout * wake);
            #endif
            vec4 color = far;

            // The galaxy's soft light turns slowly around the middle of the glass, bending as far space does
            #ifndef HOLE_ONLY
            vec2 mistAt = (p + bend * 0.6 + view * vec2(-7.0, -5.0)) - (mistBox.xy + mistBox.zw * 0.5);
            vec4 mist = part(uMist, mistBox, turn(t * tau / 90.0) * mistAt + mistBox.xy + mistBox.zw * 0.5, 0.0);
            color = over(color, mist * 0.5 * wake);
            #endif

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

            #ifndef HOLE_ONLY
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
            // the lower stroke fills a beat behind. While it fills, its front glows brighter still, so the light is seen to travel
            vec4 stroke1 = part(uWaves, wavesBox, p, -0.25) * step(wavesSplit, p.y);
            vec4 stroke0 = part(uWaves, wavesBox, p, -0.25) * step(p.y, wavesSplit);
            float along = (p.x - 878.0) / 270.0;
            float front0 = along - (uCharge.x * 1.5 - 0.25);
            float front1 = along - ((uCharge.x - 0.06) * 1.5 - 0.25);
            float filled0 = smoothstep(0.14, -0.14, front0);
            float filled1 = smoothstep(0.14, -0.14, front1);
            float running = 1.0 - smoothstep(0.8, 1.0, uCharge.x);
            float edge0 = exp(-front0 * front0 / 0.012) * running;
            float edge1 = exp(-front1 * front1 / 0.012) * running;
            stroke0.rgb *= 1.0 + filled0 * uCharge.y * (0.85 + 1.2 * smoothstep(0.5, 0.92, stroke0.r / max(stroke0.a, 0.01)));
            stroke1.rgb *= 1.0 + filled1 * uCharge.y * (0.85 + 1.2 * smoothstep(0.5, 0.92, stroke1.r / max(stroke1.a, 0.01)));
            stroke0.rgb += vec3(0.55, 0.93, 1.0) * stroke0.a * edge0 * uCharge.y * 0.45;
            stroke1.rgb += vec3(0.55, 0.93, 1.0) * stroke1.a * edge1 * uCharge.y * 0.45;
            // Their soft light, which breathes, answers the pointer and rises with the charge: the strokes' own shape a little out of
            // focus, so it glows along each line and never fills the space between them. Baked smooth, and ending in an oval well before the
            // edge of its picture. The strokes cover most of it, so the charge lights the strokes themselves the most
            float waveLight = part(uWavesLight, wavesBox, p, 0.0).a * smoothstep(1.0, 0.55, length((p - vec2(1013.0, 1198.0)) / vec2(180.0, 155.0)));
            color.rgb += cyan * waveLight * (uGlow * 0.65 + (0.07 + 0.04 * sin(t * 0.85)) * wake + (filled0 * 0.9 + edge0 * 0.45) * uCharge.y);
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
            #endif

            // The light on the glass stays on the glass, moving against everything behind it. Screen, as in the PSD
            vec4 sheen = part(uSheen, sheenBox, p + view * vec2(7.0, 5.0), 0.0);
            #ifndef HOLE_ONLY
            float sweep = fract(t / 11.0) * 3.4 - 1.2;
            float sweepAt = dot(vUv - 0.5, vec2(0.74, 0.5)) - sweep + 1.0;
            sheen.rgb *= 1.0 + 1.5 * exp(-sweepAt * sweepAt * 40.0) * wake;
            #endif
            color.rgb += sheen.rgb * (1.0 - color.rgb);

            float glass = part(uGlass, glassBox, p, 0.0).a;
            gl_FragColor = color * glass;
        }
    `,
}
