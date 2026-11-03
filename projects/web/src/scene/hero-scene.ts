// The live hero sky for Immersive. GSAP lives in this chunk alone. It drives the shared world,
// which the Still frame draws as well, so both states show the same sky, and the conductor's
// living face, cap and bow tie, see face.ts, cap.ts, bow.ts and face-life.ts.

import { gsap } from "gsap"
import { seededRandom } from "../lib/stars"
import { createBow, type Bow } from "./bow"
import { createCap, type Cap } from "./cap"
import { createFace, type Face } from "./face"
import { createFaceLife } from "./face-life"
import { setHeroFaceMoving } from "./face-turn"
import { lastArrival, quietAt } from "./rhythm"
import { createWorld, restPose, type Pose } from "./world"
import { hideFrame, showFrame, stillFrame } from "./still-frame"

export interface HeroScene {
    dispose(): void
}

const bobPixels = 6
const bobSeconds = 6.5
const breathAmount = 0.0035
const breathSeconds = 7.5
// The viewer floats on the same water: a slow sideways sway in two beats and a slight rise and fall,
// so the depths slide past each other even when nobody touches anything. Shares of the hero width
// and of the camera's height above the water
const swayWide = 0.01
const swayWideSeconds = 31
const swayShort = 0.0055
const swayShortSeconds = 19
const swayRise = 0.12
const swayRiseSeconds = 23
// Immersive parallax: the largest sideways camera shift as a share of the hero width, which moves the
// conductor about 90 px on a 1920 wide hero, and the largest change of the camera's height as a share
// of its rest height. A pointer low on the page lowers the camera toward the water
const parallaxX = 0.047
const parallaxY = 0.6
// Immersive drift under the parallax: the camera traces a slow figure eight, as wide as this share of
// the hero width and half as tall, so the scene never sits still even when the pointer does
const figureWidth = 0.006
const figureSeconds = 40
// Immersive scroll dip: as the hero scrolls away the viewer sinks toward the surface, the horizon
// climbs by up to this share of the hero height and the camera loses up to this share of its height.
// The climb starts gently, so the words and controls near the water still sit on it while they are in view
const dipLift = 0.2
const dipLiftCurve = 1.6
const dipDrop = 0.55
// The eyes' center in the conductor box, which eye contact is measured from
const eyeX = 0.4837
const eyeY = 0.5791
// The head, hat to bow tie, as an ellipse in the conductor box. Hovering it lights the waves
const headRadiusX = 0.42
const headRadiusY = 0.47
// The conductor notices: the pointer resting on a companion this long turns the eyes to it, this
// much further than the pointer alone would, for this long
const dwellSeconds = 1
const glanceReach = 1.9
const glanceSeconds = 1.4
// The mouth charges when a message reaches the conductor or a command is copied: how long the light takes to fill the waves,
// how long it stays and how long it takes to sink back
const chargeFill = 1.7
const chargeHold = 0.9
const chargeFade = 2.2
// How long the face takes to come alive once its parts are here, and how long the pointer rests before it looks around again
const faceWake = 2.6
const gazeRest = 3.5
// A body with weight: the slow lean it sways through, and how far it turns toward the pointer, in degrees
const swayDegrees = 0.9
const swayDegreesSeconds = 13
const leanDegrees = 1.4
const tau = Math.PI * 2

const smooth = (from: number, to: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
    return t * t * (3 - 2 * t)
}

// Only the newest scene may move the DOM conductor, an older one may still be fading out
let conductorOwner: object | null = null


export function createHeroScene(hero: HTMLElement): HeroScene | null {
    const slot = hero.querySelector<HTMLElement>("[data-scene-slot]")
    const conductor = hero.querySelector<HTMLElement>("[data-conductor]")
    const faceSlot = hero.querySelector<HTMLElement>("[data-face-slot]")
    const explore = hero.querySelector<HTMLElement>("[data-explore]")
    if (!slot || !conductor) return null

    const world = createWorld(hero)
    if (!world) return null
    const canvas = world.canvas
    slot.append(canvas)

    const owner = {}
    conductorOwner = owner
    conductor.style.willChange = "transform"

    let face: Face | null = null
    let cap: Cap | null = null
    let bow: Bow | null = null
    // The scene second the face's parts were all here, which it wakes from
    let faceFrom = Infinity
    const life = createFaceLife(seededRandom(4817), quietAt)
    let pointerMoved = -1e9

    // `immerse` eases from 0 to 1 as the scene wakes, so the pointer response never jumps in
    const state = { motion: 1, immerse: 0, glow: 0, px: 0, py: 0, dip: 0, ex: 0, ey: 0 }
    const pose: Pose = { ...restPose }
    // Scene time starts at zero on the first frame, so that frame is the Still frame
    let clockStart = -1
    let sceneTime = 0
    let loaded = false
    let running = false
    let disposed = false
    let released = false
    // Where the hero sits on the page, kept so pointer and scroll handlers never read layout. The scene
    // measures in screen pixels, while transforms inside the zoomed page are in its own pixels
    let heroLeft = 0
    let heroTop = 0
    let zoom = 1

    // The conductor notices a companion the pointer rests on
    let dwellIndex = -1
    let dwellSince = 0
    let glanceUntil = -1

    // The page's scroll offsets, taken in the scroll event. Reading them inside a frame, after styles have
    // changed, would make the browser work out styles and layout early on every frame the sky renders
    let pageX = window.scrollX
    let pageY = window.scrollY
    const onPageScroll = () => {
        pageX = window.scrollX
        pageY = window.scrollY
    }
    window.addEventListener("scroll", onPageScroll, { passive: true })

    const measurePage = () => {
        const box = hero.getBoundingClientRect()
        onPageScroll()
        heroLeft = box.left + pageX
        heroTop = box.top + pageY
        zoom = hero.offsetWidth > 0 ? box.width / hero.offsetWidth : 1
    }

    const pointer = { x: 0, y: 0, inside: false }

    let lean = 0
    let leaning = false
    let copiedAt = -1e9
    let chargeAt = -1e9
    const mainButton = hero.querySelector<HTMLElement>(".control.primary")
    // Released with the scene, so switching to Still and back leaves no listener holding an old scene
    const listening = new AbortController()
    const { signal } = listening
    for (const on of ["pointerenter", "focus"]) mainButton?.addEventListener(on, () => (leaning = true), { signal })
    for (const off of ["pointerleave", "blur"]) mainButton?.addEventListener(off, () => (leaning = false), { signal })
    window.addEventListener("fluxerly:copied", () => (copiedAt = sceneTime), { signal })

    const tick = (time: number) => {
        const layout = world.layout
        if (!layout) return
        if (clockStart < 0) clockStart = time
        const t = time - clockStart
        sceneTime = t
        const motion = state.motion
        const immerse = state.immerse
        const restHeight = layout.waterLine - layout.horizon
        const swayX = swayWide * Math.sin((tau * t) / swayWideSeconds) + swayShort * Math.sin((tau * t) / swayShortSeconds)
        const rise = swayRise * Math.sin((tau * t) / swayRiseSeconds)
        const figureX = figureWidth * Math.sin((tau * t) / figureSeconds) * immerse * motion
        const figureY = figureWidth * 0.5 * Math.sin((2 * tau * t) / figureSeconds) * immerse * motion
        const height = restHeight * (1 - state.py * parallaxY + rise * motion) * (1 - dipDrop * state.dip) - figureY * layout.width
        pose.time = t
        pose.bob = -bobPixels * 0.5 * (1 - Math.cos((tau * t) / bobSeconds)) * motion
        pose.breath = 1 + breathAmount * 0.5 * (1 - Math.cos((tau * t) / breathSeconds)) * motion
        pose.shiftX = (state.px * parallaxX + swayX * motion + figureX) * layout.width
        pose.shiftY = restHeight - height
        pose.lift = dipLift * layout.height * state.dip ** dipLiftCurve
        pose.dip = state.dip
        pose.drift = motion
        lean += ((leaning ? 1 : 0) - lean) * 0.08
        const copied = Math.exp(-(t - copiedAt) / 0.45)
        pose.glow = Math.max(state.glow, lean * 0.6 * motion, copied * 0.9 * motion)
        pose.notice = immerse * motion
        pose.pointerX = pointer.inside ? pointer.x - heroLeft + pageX : -1e5
        pose.pointerY = pointer.inside ? pointer.y - heroTop + pageY : -1e5
        world.render(pose)

        if (conductorOwner !== owner) return
        // The camera follows the pointer, so the conductor drifts the other way
        const y = pose.bob - pose.shiftY - pose.lift
        const tilt = (swayDegrees * Math.sin((tau * t) / swayDegreesSeconds) + leanDegrees * state.px) * motion
        conductor.style.transform = `translate3d(${(-pose.shiftX / zoom).toFixed(2)}px, ${(y / zoom).toFixed(2)}px, 0) rotate(${tilt.toFixed(3)}deg) scale(${pose.breath.toFixed(5)})`

        if (!face || t < faceFrom) return

        const wake = smooth(0, faceWake, t - faceFrom) * motion

        // A charge runs to its end before the next can start, so the light never jumps back to the left
        const sent = Math.max(lastArrival(t), copiedAt)
        if (sent > chargeAt && t - sent < 0.2 && t - chargeAt > chargeFill + chargeHold + chargeFade) chargeAt = sent
        const charged = t - chargeAt
        const charge = smooth(0, chargeFill, charged)
        const chargeOut = 1 - smooth(chargeFill + chargeHold, chargeFill + chargeHold + chargeFade, charged)

        // Immersive: resting the pointer on a companion turns the conductor's eyes to it after a blink
        if (immersive && pointer.inside && world.under.index >= 0) {
            if (world.under.index !== dwellIndex) {
                dwellIndex = world.under.index
                dwellSince = t
            } else if (dwellSince >= 0 && t - dwellSince > dwellSeconds) {
                dwellSince = -1
                glanceUntil = t + glanceSeconds
                life.blink(t)
                look(heroLeft - pageX + world.under.x, heroTop - pageY + world.under.y, glanceReach)
            }
        } else {
            dwellIndex = -1
        }
        if (glanceUntil >= 0 && t > glanceUntil) {
            glanceUntil = -1
            watchPointer()
        }

        // Eye contact while the pointer moves or a glance holds. Otherwise it looks around by itself
        const contact = pointer.inside && (t - pointerMoved < gazeRest || glanceUntil >= 0)
        // The cap fills with the body's breath and with the waves' charge, so it moves in time with both
        const faceState = life.update({
            time: t,
            wake,
            gaze: contact ? gazeTarget : null,
            attention: state.glow,
            joy: copied,
            breath: 0.5 * (1 - Math.cos((tau * t) / breathSeconds)),
            charge: charge * chargeOut,
        })
        face.render({
            time: t,
            wake,
            state: faceState,
            glow: pose.glow,
            charge,
            chargeLevel: Math.min(1, charged / 0.3) * chargeOut * wake,
            viewX: state.px,
            viewY: state.py,
        })
        cap?.render(faceState.cap)
        bow?.render(faceState.bow)
    }

    // The sky renders only while some of the hero is on screen. Below it, a frame nobody sees would
    // still cost the GPU a full redraw of the scene on every frame of the reader's scroll
    let inView = true

    const start = () => {
        if (running || !loaded || released || document.hidden || !inView) return
        gsap.ticker.add(tick)
        running = true
        setHeroFaceMoving(owner, face !== null)
    }

    const stop = () => {
        if (!running) return
        gsap.ticker.remove(tick)
        running = false
        setHeroFaceMoving(owner, false)
    }

    const onVisibility = () => (document.hidden ? stop() : start())
    document.addEventListener("visibilitychange", onVisibility)
    const viewObserver = new IntersectionObserver((entries) => {
        inView = entries[entries.length - 1].isIntersecting
        if (inView) {
            if (immersive) onScroll()
            start()
        } else {
            stop()
        }
    })
    viewObserver.observe(hero)

    const resizeObserver = new ResizeObserver(() => {
        if (!loaded || released) return
        world.relayout()
        measurePage()
        face?.resize()
    })
    resizeObserver.observe(hero)

    // Immersive only: pointer parallax, the waves highlight, the scroll dip and eye contact
    const followX = gsap.quickTo(state, "px", { duration: 1.6, ease: "power3.out" })
    const followY = gsap.quickTo(state, "py", { duration: 1.6, ease: "power3.out" })
    const followDip = gsap.quickTo(state, "dip", { duration: 0.9, ease: "power3.out" })
    // Where eye contact wants the eyes, each from -1 to 1. The face's own quick move carries them there
    const gazeTarget = { x: 0, y: 0 }
    let exploreHovered = false
    let exploreFocused = false
    let headHovered = false

    const updateGlow = () => {
        const on = exploreHovered || exploreFocused || headHovered
        gsap.to(state, { glow: on ? 1 : 0, duration: on ? 0.7 : 0.9, ease: on ? "power2.out" : "power2.inOut", overwrite: "auto" })
    }

    // A point of the conductor box in viewport pixels, where the conductor is right now
    const conductorPoint = (u: number, v: number) => {
        const box = world.layout!.conductor
        return [
            heroLeft - pageX + box.left + box.width * u - pose.shiftX,
            heroTop - pageY + box.top + box.height * v + pose.bob - pose.shiftY - pose.lift,
        ]
    }

    // Turns the eyes toward a point in viewport pixels, all the way once it is a head's width away
    const look = (x: number, y: number, reach: number) => {
        const box = world.layout!.conductor
        const [lookX, lookY] = conductorPoint(eyeX, eyeY)
        const dx = x - lookX
        const dy = y - lookY
        const distance = Math.hypot(dx, dy) || 1
        const pull = (Math.min(1, distance / box.width) * reach) / distance
        gazeTarget.x = Math.max(-1, Math.min(1, dx * pull))
        gazeTarget.y = Math.max(-1, Math.min(1, dy * pull))
    }

    const watchPointer = () => {
        const layout = world.layout
        if (!layout || !pointer.inside) {
            if (headHovered) {
                headHovered = false
                updateGlow()
            }
            return
        }
        const box = layout.conductor
        const [headX, headY] = conductorPoint(0.5, 0.5)
        const hx = (pointer.x - headX) / (box.width * headRadiusX)
        const hy = (pointer.y - headY) / (box.height * headRadiusY)
        const over = hx * hx + hy * hy < 1
        if (over !== headHovered) {
            headHovered = over
            updateGlow()
        }
        // A glance at a companion holds the eyes until it ends
        if (glanceUntil < 0 || sceneTime > glanceUntil) look(pointer.x, pointer.y, 1)
    }

    const onPointerMove = (event: PointerEvent) => {
        if (event.pointerType === "touch") return
        followX((event.clientX / window.innerWidth) * 2 - 1)
        followY((event.clientY / window.innerHeight) * 2 - 1)
        pointer.x = event.clientX
        pointer.y = event.clientY
        pointer.inside = true
        pointerMoved = sceneTime
        watchPointer()
    }
    const onPointerLeave = () => {
        followX(0)
        followY(0)
        pointer.inside = false
        glanceUntil = -1
        watchPointer()
    }
    const onScroll = () => {
        const layout = world.layout
        // Out of view the sky does not render, so its dip waits until the hero comes back
        if (!layout || !inView) return
        // The stacked layout keeps its water below the fold, so it does not sink
        followDip(layout.stacked ? 0 : Math.min(1, Math.max(0, (window.scrollY - heroTop) / layout.height)))
        if (pointer.inside) watchPointer()
    }
    const onExploreEnter = () => {
        exploreHovered = true
        updateGlow()
    }
    const onExploreLeave = () => {
        exploreHovered = false
        updateGlow()
    }
    const onExploreFocus = () => {
        exploreFocused = true
        updateGlow()
    }
    const onExploreBlur = () => {
        exploreFocused = false
        updateGlow()
    }

    const immersiveListeners: [EventTarget | null, string, EventListener][] = [
        [window, "pointermove", onPointerMove as EventListener],
        [window, "scroll", onScroll],
        [document.documentElement, "pointerleave", onPointerLeave],
        [explore, "pointerenter", onExploreEnter],
        [explore, "pointerleave", onExploreLeave],
        [explore, "focus", onExploreFocus],
        [explore, "blur", onExploreBlur],
    ]

    let immersive = false
    const setImmersive = (on: boolean) => {
        if (on === immersive) return
        immersive = on
        for (const [target, type, listener] of immersiveListeners) {
            if (on) target?.addEventListener(type, listener, { passive: true })
            else target?.removeEventListener(type, listener)
        }
        gsap.to(state, { immerse: on ? 1 : 0, duration: 1.2, ease: "power2.inOut", overwrite: "auto" })
        if (!on) {
            exploreHovered = false
            exploreFocused = false
            dwellIndex = -1
            onPointerLeave()
            followDip(0)
            updateGlow()
        } else {
            onScroll()
            if (explore) {
                exploreHovered = explore.matches(":hover")
                exploreFocused = explore.matches(":focus-visible")
                if (exploreHovered || exploreFocused) updateGlow()
            }
        }
    }

    const release = () => {
        if (released) return
        released = true
        disposed = true
        stop()
        setImmersive(false)
        gsap.killTweensOf(state)
        gsap.killTweensOf(canvas)
        for (const follow of [followX, followY, followDip]) follow.tween.kill()
        document.removeEventListener("visibilitychange", onVisibility)
        viewObserver.disconnect()
        resizeObserver.disconnect()
        window.removeEventListener("scroll", onPageScroll)
        canvas.removeEventListener("webglcontextlost", onContextLost)
        listening.abort()
        if (conductorOwner === owner) {
            conductor.style.transform = ""
            conductor.style.willChange = ""
            conductorOwner = null
        }
        world.release()
        face?.release()
        face = null
        cap?.release()
        cap = null
        bow?.release()
        bow = null
    }

    // If the GPU drops the context, fall back to the CSS sky underneath. A kept frame may be stale
    const onContextLost = () => {
        if (hero.dataset.scene === "live" && conductorOwner === owner) {
            delete hero.dataset.scene
            const frame = stillFrame(hero)
            if (frame) hideFrame(frame)
        }
        release()
    }
    canvas.addEventListener("webglcontextlost", onContextLost)

    // The face comes after the sky and takes over from the painted glass when all its parts are here, and the cap and the bow tie
    // with it, so all wake together from rest. If the face can't, the conductor simply stays as painted, and if only the cap or the
    // bow can't, so does that part
    const startFace = () => {
        if (!faceSlot) return
        const made = createFace(faceSlot)
        if (!made) return
        const madeCap = createCap(conductor)
        const mascot = conductor.querySelector<HTMLImageElement>("[data-mascot]")
        const madeBow = mascot ? createBow(conductor, mascot) : null
        const partHere = (madePart: Cap | Bow | null, name: string) =>
            madePart
                ? madePart.load().then(
                      () => true,
                      (reason) => {
                          if (!released) console.warn(`The conductor's ${name} stays as painted:`, reason)
                          madePart.release()
                          return false
                      },
                  )
                : false
        Promise.all([made.load(), partHere(madeCap, "cap"), partHere(madeBow, "bow tie")])
            .then(([, withCap, withBow]) => {
                if (released) {
                    made.release()
                    madeCap.release()
                    madeBow?.release()
                    return
                }
                faceSlot.append(made.canvas)
                face = made
                setHeroFaceMoving(owner, running)
                if (withCap) cap = madeCap
                if (withBow) bow = madeBow
                faceFrom = sceneTime
                // Its first frame at rest, then it fades in over the painted glass, whose sharpness differs a little
                tick(gsap.ticker.time)
                requestAnimationFrame(() => (made.canvas.dataset.on = ""))
            })
            .catch((reason) => {
                if (!released) console.warn("The conductor's face stays as painted:", reason)
                made.release()
                madeCap.release()
                madeBow?.release()
            })
    }

    world
        .load()
        .then(() => {
            if (disposed || !world.relayout()) {
                release()
                return
            }
            loaded = true
            measurePage()
            setImmersive(true)
            startFace()
            world.loadParts().catch((reason) => {
                if (!released) console.warn("The sky's icons stay whole:", reason)
            })
            tick(gsap.ticker.time)
            start()
            hero.dataset.scene = "live"
            // Once the live sky covers the Still frame, the frame stops costing a layer. Leaving repaints it
            const frame = slot.querySelector<HTMLCanvasElement>("canvas[data-scene-frame]")
            gsap.to(canvas, { opacity: 1, duration: 1.2, ease: "power2.out", onComplete: () => frame && hideFrame(frame) })
        })
        .catch(() => release())

    return {
        dispose() {
            if (disposed) return
            disposed = true
            setImmersive(false)
            if (conductorOwner === owner) delete hero.dataset.scene
            if (!loaded) {
                // Still loading. The load handler releases everything
                return
            }
            // Leave the rest frame under the canvas for Still, then put the live frame back
            const frame = stillFrame(hero)
            if (frame && world.layout) {
                world.render(restPose)
                world.capture(frame)
                world.render(pose)
                showFrame(frame, true)
                if (conductorOwner === owner) hero.dataset.scene = "frame"
            }
            // Settle the conductor and the companions back to rest while the canvas fades out over the frame
            gsap.to(state, { motion: 0, immerse: 0, glow: 0, px: 0, py: 0, dip: 0, duration: 0.5, ease: "power2.out", overwrite: true })
            gsap.to(canvas, { opacity: 0, duration: 0.5, ease: "power2.out", overwrite: true, onComplete: release })
        },
    }
}
