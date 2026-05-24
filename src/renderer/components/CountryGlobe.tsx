import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Globe, { type GlobeMethods } from 'react-globe.gl'
import * as THREE from 'three'
import geoUrl from '../assets/world-countries-110m.geojson?url'
import { polyKey, type PolyFeature } from '../utils/country-normalization'

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

  // Blue ramp matching the app's slate/blue accent palette.
  // Start: deep cool blue (1 node) -> base blue-500 #3b82f6 (median)
  // -> pale near-white blue #cfe3ff for top-quartile glow.
  function capColor(count: number): string {
    if (count <= 0 || maxLog <= 0) return 'rgba(0, 0, 0, 0)'
    const t = norm(count)
    const glow = count >= top75
    const rEnd = glow ? 0xcf : 0x3b
    const gEnd = glow ? 0xe3 : 0x82
    const bEnd = glow ? 0xff : 0xf6
    const r = lerp(0x0f, rEnd, t)
    const g = lerp(0x29, gEnd, t)
    const b = lerp(0x4d, bEnd, t)
    const a = 0.82 + 0.16 * t
    return `rgba(${r},${g},${b},${a.toFixed(2)})`
  }

  function strokeColor(count: number): string {
    if (count <= 0) return 'rgba(96, 165, 250, 0.55)'
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

export default function CountryGlobe({ counts, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const globeRef = useRef<GlobeMethods | undefined>(undefined)
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

  // Load GeoJSON once
  useEffect(() => {
    let cancelled = false
    fetch(geoUrl)
      .then((r) => r.json() as Promise<GeoJson>)
      .then((data) => {
        if (!cancelled) setFeatures(data.features ?? [])
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

  const darkMatte = useMemo(
    () => new THREE.MeshPhongMaterial({ color: 0x0c0c10 }),
    [],
  )

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
      return `<div style="background:#0a0a0f;color:#e5e5e5;padding:4px 8px;border:1px solid #333;border-radius:3px;font-size:12px;">${name}${c > 0 ? ` (${c})` : ''}</div>`
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
      {size.w > 0 && size.h > 0 && (
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
              g.pointOfView({ lat: 35, lng: 15, altitude: 2.2 }, 0)
              setReady(true)
              armAutoPause()
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
