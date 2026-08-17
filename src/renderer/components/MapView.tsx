import { lazy, Suspense, useMemo } from 'react'
import { useNodes } from '../hooks/useNodes'
import { useNavigation } from '../contexts/NavigationContext'
import CountrySidebar from './CountrySidebar'
import ErrorBoundary from './ErrorBoundary'
import Spinner from './Spinner'

// three.js + react-globe.gl are large; only load them when the Map tab is opened.
const CountryGlobe = lazy(() => import('./CountryGlobe'))

// three.js constructs its WebGLRenderer eagerly and throws "Error creating WebGL
// context." when the browser refuses a context. Chromium 146 refuses one outright
// on a machine with no usable GPU (see the enable-unsafe-swiftshader note in
// main/index.ts), so ask first rather than letting the throw escape: this tab is
// the app's default landing tab, so an uncaught throw here means the client never
// draws its main interface at all.
//
// Cached per process: the answer cannot change without a restart, and the probe
// allocates a real context. Chromium caps how many can be live at once and drops
// the oldest when the cap is hit, so the probe hands its own back immediately
// rather than leaving one to compete with the globe's.
let webglSupported: boolean | null = null
function hasWebgl(): boolean {
  if (webglSupported === null) {
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      webglSupported = !!gl
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      webglSupported = false
    }
  }
  return webglSupported
}

// Shown in place of the globe. The country list beside it needs no WebGL, so the
// tab keeps working: this replaces one panel, not the feature.
function GlobeUnavailable() {
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-2">
        <p className="text-sm text-text-primary">3D map unavailable</p>
        <p className="text-xs text-text-secondary">
          This system has no graphics acceleration available, so the globe cannot be
          drawn. Pick a country from the list to browse its nodes.
        </p>
      </div>
    </div>
  )
}

export default function MapView() {
  const { nodes, lastFetched } = useNodes()
  const { goToNodesForCountry } = useNavigation()

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of nodes) {
      if (n.country) m.set(n.country, (m.get(n.country) ?? 0) + 1)
    }
    return m
  }, [nodes])

  if (!lastFetched) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-text-secondary text-sm flex items-center gap-2">
          <Spinner />
          Loading countries...
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex">
      <CountrySidebar counts={counts} onSelect={goToNodesForCountry} />
      <div className="flex-1 relative">
        {hasWebgl() ? (
          // Defense in depth behind the probe: a context can still be refused
          // after it passed, most plausibly when Chromium drops the oldest
          // context because too many have been created (see the forceContextLoss
          // cleanup in CountryGlobe). Losing the globe is acceptable, losing the
          // window is not.
          <ErrorBoundary fallback={<GlobeUnavailable />}>
            <Suspense fallback={null}>
              <CountryGlobe counts={counts} onSelect={goToNodesForCountry} />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <GlobeUnavailable />
        )}
      </div>
    </div>
  )
}
