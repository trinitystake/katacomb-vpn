import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Globe, { type GlobeMethods } from 'react-globe.gl'
import * as THREE from 'three'
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

// CPU-idle behavior. Globe.gl runs a continuous Three.js requestAnimationFrame
// loop at host refresh rate (~60 Hz). On a static chloropleth that's a sustained
// CPU + GPU draw for nothing changing on screen. We pauseAnimation() after
// IDLE_PAUSE_MS of no interaction and resumeAnimation() on:
//   - any pointer event on the canvas (drag/hover/wheel)
//   - window focus / document becoming visible
//   - the underlying `counts` prop changing
// We also pause immediately on window blur or tab/window hidden.
const IDLE_PAUSE_MS = 1200

// Parse the 436 KB GeoJSON once per process. The globe unmounts on every tab
// switch, so without this cache it re-fetches + re-parses each time (finding L15).
let cachedFeatures: Feature[] | null = null

export default function CountryGlobe({ counts, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const globeRef = useRef<GlobeMethods | undefined>(undefined)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const [features, setFeatures] = useState<Feature[]>([])
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  // Hidden until onGlobeReady has fired and the initial camera is set,
  // otherwise the user sees one frame at globe.gl's default altitude
  // (camera appears as a tiny sphere) before our pointOfView lands.
  const [ready, setReady] = useState(false)

  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isPausedRef = useRef(false)

  const doPause = () => {
    if (!globeRef.current || isPausedRef.current) return
    globeRef.current.pauseAnimation()
    isPausedRef.current = true
  }
  const doResume = () => {
    if (!globeRef.current) return
    if (isPausedRef.current) {
      globeRef.current.resumeAnimation()
      isPausedRef.current = false
    }
    armAutoPause()
  }
  const armAutoPause = () => {
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
    pauseTimerRef.current = setTimeout(doPause, IDLE_PAUSE_MS)
  }

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
        // silent — globe will render bare sphere
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Track container size for the canvas
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

  // Pointer activity on the container resumes (and re-arms the auto-pause).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onActivity = () => doResume()
    const events: (keyof HTMLElementEventMap)[] = ['pointermove', 'pointerdown', 'wheel', 'touchstart']
    events.forEach((e) => el.addEventListener(e, onActivity, { passive: true }))
    return () => {
      events.forEach((e) => el.removeEventListener(e, onActivity))
    }
  }, [])

  // Window/tab visibility: pause immediately when hidden or blurred.
  useEffect(() => {
    const onBlur = () => doPause()
    const onFocus = () => doResume()
    const onVisibility = () => {
      if (document.hidden) doPause()
      else doResume()
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // Clean up the pause timer when the Globe unmounts (tab switch).
  useEffect(() => {
    return () => {
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
    }
  }, [])

  // Resume on data change so the user sees the new chloropleth render in.
  useEffect(() => {
    if (ready) doResume()
  }, [counts, ready])

  // Resume on container resize. Without this, the render loop stays paused
  // and the canvas appears frozen at the old size until the user interacts —
  // visible as a 1+ second lag when dragging the window edge.
  useEffect(() => {
    if (ready) doResume()
  }, [size.w, size.h, ready])

  // gunmetal-950 — the sphere reads as the app's deepest surface, so the ocean
  // recedes behind the bronze landmasses instead of framing them in cold black.
  const darkMatte = useMemo(
    () => new THREE.MeshPhongMaterial({ color: 0x101114 }),
    [],
  )

  // Free the WebGL context + app-owned material on unmount (tab switch). globe.gl
  // disposes its own objects but never releases the GL context, so each remount
  // would leak one until Chromium drops the oldest and the globe goes black
  // (findings H8/M8).
  useEffect(() => {
    return () => {
      const renderer = rendererRef.current
      try { renderer?.forceContextLoss() } catch { /* ignore */ }
      try { renderer?.dispose() } catch { /* ignore */ }
      darkMatte.dispose()
    }
  }, [darkMatte])

  const { capColor, strokeColor } = useMemo(() => makeColorFns(counts), [counts])

  // Memoize the accessors react-globe.gl calls per polygon. New function
  // identities cause react-globe.gl to re-run accessors against every feature,
  // so keeping these stable across renders avoids redundant work on each tick.
  const countFor = useCallback(
    (d: object) => counts.get(polyKey(d as Feature)) ?? 0,
    [counts],
  )
  const polygonCapColorFn = useCallback(
    (d: object) => capColor(countFor(d)),
    [capColor, countFor],
  )
  const polygonSideColorFn = useCallback(() => 'rgba(0,0,0,0)', [])
  const polygonStrokeColorFn = useCallback(
    (d: object) => strokeColor(countFor(d)),
    [strokeColor, countFor],
  )
  const polygonLabelFn = useCallback(
    (d: object) => {
      const name = polyKey(d as Feature)
      const c = countFor(d)
      // globe.gl takes raw HTML, so this is styled inline rather than by class —
      // but the custom properties still resolve against :root, so it tracks the
      // theme tokens like everything else.
      return `<div style="background:var(--color-bg-primary);color:var(--color-text-primary);padding:4px 8px;border:1px solid var(--color-border);border-radius:3px;font-size:12px;">${name}${c > 0 ? ` (${c})` : ''}</div>`
    },
    [countFor],
  )
  const onPolygonClickFn = useCallback(
    (d: object) => {
      const c = countFor(d)
      if (c > 0) onSelect(polyKey(d as Feature))
    },
    [countFor, onSelect],
  )

  const recenter = useCallback(() => {
    const g = globeRef.current
    if (!g) return
    g.pointOfView({ lat: 35, lng: 15, altitude: 2.2 }, 1000)
    // Need the render loop running for the 1 s tween to actually animate.
    doResume()
  }, [])

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

  return (
    <div ref={containerRef} className="absolute inset-0">
      {/* Loader covers the globe area until the canvas is fully composed.
          Hides the dark-empty gap between tab-mount and the chloropleth
          fade-in. Hidden once `ready` flips after onGlobeReady + 2 rAFs. */}
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-text-secondary text-sm flex items-center gap-2">
            <Spinner />
            Loading map...
          </div>
        </div>
      )}

      {/*
        Mount the Globe only once we have BOTH container dimensions AND the
        country polygons. Mounting earlier shows a bare dark sphere for a
        few frames while the GeoJSON fetch resolves — visible as the "small
        black sphere" flash the user otherwise sees on first load.
      */}
      {size.w > 0 && size.h > 0 && features.length > 0 && (
        <div
          className={`absolute inset-0 transition-opacity duration-300 ${ready ? 'opacity-100' : 'opacity-0'}`}
        >
          <Globe
            ref={globeRef}
            width={size.w}
            height={size.h}
            backgroundColor="rgba(0,0,0,0)"
            showAtmosphere={false}
            globeMaterial={darkMatte}
            polygonsData={features}
            polygonAltitude={0.008}
            polygonCapColor={polygonCapColorFn}
            polygonSideColor={polygonSideColorFn}
            polygonStrokeColor={polygonStrokeColorFn}
            polygonLabel={polygonLabelFn}
            onPolygonClick={onPolygonClickFn}
            polygonsTransitionDuration={0}
            onGlobeReady={() => {
              const g = globeRef.current
              if (!g) return
              // Cap the WebGL renderer at 1x device pixel ratio. On HiDPI
              // displays the default 2x means 4x the fragment-shader work for
              // a flat chloropleth that gains almost nothing from super-sampling.
              const renderer = g.renderer()
              if (renderer && typeof renderer.setPixelRatio === 'function') {
                renderer.setPixelRatio(1)
              }
              rendererRef.current = renderer
              g.pointOfView({ lat: 35, lng: 15, altitude: 2.2 }, 0)
              // Wait two animation frames before fading in: onGlobeReady
              // fires before the polygon meshes have actually rendered, so
              // flipping opacity immediately can still show a bare sphere
              // for one frame.
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  setReady(true)
                  armAutoPause()
                })
              })
            }}
          />
        </div>
      )}

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
