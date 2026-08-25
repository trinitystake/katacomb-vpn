import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { geoOrthographic, geoPath, geoGraticule10 } from 'd3-geo'
import geoUrl from '../assets/world-countries-110m.geojson?url'
import { polyKey, type PolyFeature } from '../utils/country-normalization'
import Spinner from './Spinner'

interface Props {
  counts: Map<string, number>
  onSelect: (country: string) => void
}

interface Feature extends PolyFeature {
  properties?: { name?: string }
}

interface GeoJson {
  features: Feature[]
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

// Heavy-tailed distribution: a single country can hold 30x the median's
// node count. Log scale prevents the leader from dominating the ramp.
function makeColorFns(counts: Map<string, number>) {
  const values = Array.from(counts.values()).filter((v) => v > 0)
  const max = values.reduce((m, v) => (v > m ? v : m), 0)
  const maxLog = max > 0 ? Math.log(max + 1) : 0
  const sorted = values.slice().sort((a, b) => a - b)
  const top75 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.75)] : Infinity

  function norm(count: number): number {
    if (count <= 0 || maxLog <= 0) return 0
    return Math.log(count + 1) / maxLog
  }

  // Bronze ramp, walking the app icon's own gradient from its dark end to its
  // highlight — this is the one place the brand gradient is used as a gradient
  // rather than a flat accent, and node density is a real quantity to encode.
  // Start: deep bronze (1 node) -> bronze-400 #c39874 (median)
  // -> champagne highlight #f2d5b2 for top-quartile glow.
  function capColor(count: number): string {
    if (count <= 0 || maxLog <= 0) return 'rgba(0, 0, 0, 0)'
    const t = norm(count)
    const glow = count >= top75
    const rEnd = glow ? 0xf2 : 0xc3
    const gEnd = glow ? 0xd5 : 0x98
    const bEnd = glow ? 0xb2 : 0x74
    const r = lerp(0x4d, rEnd, t)
    const g = lerp(0x38, gEnd, t)
    const b = lerp(0x26, bEnd, t)
    const a = 0.82 + 0.16 * t
    return `rgba(${r},${g},${b},${a.toFixed(2)})`
  }

  // Outline for countries with no nodes. Champagne is a much lighter colour than
  // the blue-400 this replaced (0.55 vs 0.36 relative luminance), so the alpha
  // drops to keep the empty-country mesh at the same perceived weight.
  function strokeColor(count: number): string {
    if (count <= 0) return 'rgba(225, 188, 153, 0.38)'
    return 'rgba(0, 0, 0, 0.55)'
  }

  return { capColor, strokeColor }
}

// Parse the 436 KB GeoJSON once per process. The globe unmounts on every tab
// switch, so without this cache it re-fetches + re-parses each time (finding L15).
let cachedFeatures: Feature[] | null = null

// The view the globe opens on and the recenter button returns to. Kept as a
// lat/lng pair rather than a rotation so it reads the same as the old camera.
const HOME = { lat: 35, lng: 15 }
const RECENTER_MS = 1000

// How far the pointer must travel before a press counts as a drag rather than
// a click on a country.
const DRAG_THRESHOLD_PX = 4

// Zoom bounds, as multiples of the scale that fits the sphere to the container.
const MIN_ZOOM = 0.85
const MAX_ZOOM = 4

// d3 wants the rotation that BRINGS a point to the centre, which is its negation.
function rotationFor(lat: number, lng: number): [number, number] {
  return [-lng, -lat]
}

export default function CountryGlobe({ counts, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const sphereRef = useRef<SVGPathElement>(null)
  const graticuleRef = useRef<SVGPathElement>(null)
  const countryRefs = useRef<(SVGPathElement | null)[]>([])
  const tooltipRef = useRef<HTMLDivElement>(null)

  const [features, setFeatures] = useState<Feature[]>([])
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [hover, setHover] = useState<{ name: string; count: number } | null>(null)

  // Camera state lives in refs, not state: a drag moves it every pointermove and
  // the paths are rewritten imperatively below, so re-rendering 177 React
  // elements per frame would be pure waste. Nothing else reads these.
  const rotationRef = useRef<[number, number]>(rotationFor(HOME.lat, HOME.lng))
  const zoomRef = useRef(1)

  // Load GeoJSON once (cached at module level across remounts)
  useEffect(() => {
    if (cachedFeatures) {
      setFeatures(cachedFeatures)
      return
    }
    let cancelled = false
    fetch(geoUrl)
      .then((r) => r.json() as Promise<GeoJson>)
      .then((data) => {
        cachedFeatures = data.features ?? []
        if (!cancelled) setFeatures(cachedFeatures)
      })
      .catch(() => {
        // silent — globe will render as a bare sphere
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Track container size so the projection can be refitted.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitScale = size.w > 0 && size.h > 0 ? (Math.min(size.w, size.h) / 2) * 0.92 : 0

  // One projection instance for the life of the component; the draw below mutates
  // its rotation/scale in place rather than rebuilding the path generator.
  const projection = useMemo(() => geoOrthographic().clipAngle(90), [])
  const pathGen = useMemo(() => geoPath(projection), [projection])
  const graticule = useMemo(() => geoGraticule10(), [])

  // Write every `d` attribute straight to the DOM. Called on drag, zoom, resize
  // and after the feature list arrives.
  const draw = useCallback(() => {
    if (!fitScale) return
    projection
      .rotate(rotationRef.current)
      .scale(fitScale * zoomRef.current)
      .translate([size.w / 2, size.h / 2])

    sphereRef.current?.setAttribute('d', pathGen({ type: 'Sphere' }) ?? '')
    graticuleRef.current?.setAttribute('d', pathGen(graticule) ?? '')
    for (let i = 0; i < features.length; i++) {
      const el = countryRefs.current[i]
      if (!el) continue
      // Back-hemisphere features project to nothing; geoPath returns null and the
      // empty `d` hides them, which is the clipping we want for free.
      el.setAttribute('d', pathGen(features[i] as Parameters<typeof pathGen>[0]) ?? '')
    }
  }, [fitScale, features, graticule, pathGen, projection, size.w, size.h])

  // Redraw whenever geometry inputs change. Colours are React's job, not this one.
  useEffect(() => {
    draw()
  }, [draw])

  // Drag to rotate. Scaled by zoom so a dragged pixel moves the same amount of
  // surface however far in the user is.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    // `pressed` is "the button is down", `dragging` is "it has moved far enough
    // to be a drag". They are separate because pointer capture is what breaks a
    // click: capturing on pointerdown retargets the whole gesture to this <svg>,
    // so the pointerup lands here rather than on the <path> and the browser
    // never synthesises a click on the country. Capture only once the pointer
    // has actually travelled, and a plain click still reaches the path.
    let pressed = false
    let dragging = false
    let downX = 0
    let downY = 0
    let lastX = 0
    let lastY = 0
    let frame = 0

    const onDown = (e: PointerEvent) => {
      pressed = true
      dragging = false
      downX = lastX = e.clientX
      downY = lastY = e.clientY
    }
    const onMove = (e: PointerEvent) => {
      if (tooltipRef.current) {
        const rect = el.getBoundingClientRect()
        tooltipRef.current.style.transform =
          `translate(${e.clientX - rect.left + 12}px, ${e.clientY - rect.top + 12}px)`
      }
      if (!pressed) return
      if (!dragging) {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) < DRAG_THRESHOLD_PX) return
        dragging = true
        el.setPointerCapture(e.pointerId)
      }
      // Degrees per pixel at the current scale, so the surface tracks the cursor
      // instead of the globe spinning faster the further the user zooms in.
      const k = 360 / (projection.scale() * 2 * Math.PI)
      const [lambda, phi] = rotationRef.current
      // Latitude is clamped so the pole never rolls past vertical, which would
      // flip the globe and read as a glitch rather than a rotation.
      rotationRef.current = [
        lambda + (e.clientX - lastX) * k,
        Math.max(-90, Math.min(90, phi - (e.clientY - lastY) * k)),
      ]
      lastX = e.clientX
      lastY = e.clientY
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw() })
    }
    const onUp = (e: PointerEvent) => {
      pressed = false
      dragging = false
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const next = zoomRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1)
      zoomRef.current = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next))
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw() })
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('wheel', onWheel)
    }
  }, [draw, projection])

  const recenter = useCallback(() => {
    const from: [number, number] = [...rotationRef.current]
    const to = rotationFor(HOME.lat, HOME.lng)
    const fromZoom = zoomRef.current
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / RECENTER_MS)
      // easeOutCubic, so it settles rather than stopping dead
      const e = 1 - Math.pow(1 - t, 3)
      rotationRef.current = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]
      zoomRef.current = fromZoom + (1 - fromZoom) * e
      draw()
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [draw])

  const { capColor, strokeColor } = useMemo(() => makeColorFns(counts), [counts])

  const countFor = useCallback(
    (f: Feature) => counts.get(polyKey(f)) ?? 0,
    [counts],
  )

  // Aggregate stats for the bottom-right chip.
  const totalNodes = useMemo(
    () => Array.from(counts.values()).reduce((s, n) => s + n, 0),
    [counts],
  )
  const litCountries = useMemo(
    () => Array.from(counts.values()).filter((n) => n > 0).length,
    [counts],
  )
  const fmtNum = (n: number) => n.toLocaleString('en')

  const ready = features.length > 0 && fitScale > 0

  return (
    <div ref={containerRef} className="absolute inset-0">
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-text-secondary text-sm flex items-center gap-2">
            <Spinner />
            Loading map...
          </div>
        </div>
      )}

      {ready && (
        <svg
          ref={svgRef}
          width={size.w}
          height={size.h}
          className="absolute inset-0 touch-none select-none cursor-grab active:cursor-grabbing"
        >
          <defs>
            {/* Limb shading. Not a light model: a soft darkening toward the edge
                is enough to read the disc as a sphere against the app's own
                near-black background. */}
            <radialGradient id="globe-limb" cx="50%" cy="50%" r="50%">
              <stop offset="60%" stopColor="#000" stopOpacity="0" />
              <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
            </radialGradient>
          </defs>

          {/* gunmetal-950 — the sphere reads as the app's deepest surface, so the
              ocean recedes behind the bronze landmasses instead of framing them
              in cold black. */}
          <path ref={sphereRef} fill="#101114" />
          <path
            ref={graticuleRef}
            fill="none"
            stroke="rgba(225, 188, 153, 0.07)"
            strokeWidth={0.5}
          />

          {features.map((f, i) => {
            const count = countFor(f)
            return (
              <path
                key={polyKey(f) || i}
                ref={(el) => { countryRefs.current[i] = el }}
                fill={capColor(count)}
                stroke={strokeColor(count)}
                strokeWidth={0.5}
                style={{ cursor: count > 0 ? 'pointer' : 'default' }}
                onPointerEnter={() => setHover({ name: polyKey(f), count })}
                onPointerLeave={() => setHover(null)}
                onClick={() => { if (count > 0) onSelect(polyKey(f)) }}
              />
            )
          })}

          <path d={pathGen({ type: 'Sphere' }) ?? ''} fill="url(#globe-limb)" pointerEvents="none" />
        </svg>
      )}

      {/* Follows the pointer via a transform written in the move handler, so
          hovering does not re-render on every mouse position. */}
      <div
        ref={tooltipRef}
        className={`absolute top-0 left-0 pointer-events-none z-10 ${hover ? '' : 'hidden'}`}
      >
        {hover && (
          <div className="px-2 py-1 rounded-sm bg-bg-primary border border-border text-text-primary text-xs whitespace-nowrap">
            {hover.name}{hover.count > 0 ? ` (${hover.count})` : ''}
          </div>
        )}
      </div>

      {ready && (
        <>
          {/* Recenter button — bottom-left overlay */}
          <button
            onClick={recenter}
            title="Recenter map"
            aria-label="Recenter map"
            className="absolute left-3 bottom-3 w-9 h-9 flex items-center justify-center rounded-sm bg-bg-secondary/80 border border-accent/40 text-accent hover:bg-bg-secondary hover:border-accent transition-colors backdrop-blur-sm"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="6" />
              <line x1="12" y1="2" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="2" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="22" y2="12" />
            </svg>
          </button>

          {/* Aggregate stats chip — bottom-right summary of network size */}
          <div
            className="absolute right-3 bottom-3 px-3 py-1.5 rounded-sm bg-bg-secondary/80 border border-accent/40 text-text-secondary text-[11px] uppercase tracking-wider flex items-baseline gap-2.5 pointer-events-none backdrop-blur-sm"
          >
            <span className="flex items-baseline gap-1">
              <span className="text-accent text-[15px] font-semibold tabular-nums normal-case tracking-normal">
                {fmtNum(totalNodes)}
              </span>
              <span>nodes</span>
            </span>
            <span className="h-3 w-px bg-accent/30" />
            <span className="flex items-baseline gap-1">
              <span className="text-accent text-[15px] font-semibold tabular-nums normal-case tracking-normal">
                {fmtNum(litCountries)}
              </span>
              <span>countries</span>
            </span>
          </div>
        </>
      )}
    </div>
  )
}
