import { useMemo } from 'react'
import { useNodes } from '../hooks/useNodes'
import { useNavigation } from '../contexts/NavigationContext'
import CountrySidebar from './CountrySidebar'
import CountryGlobe from './CountryGlobe'
import Spinner from './Spinner'

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
        <CountryGlobe counts={counts} onSelect={goToNodesForCountry} />
      </div>
    </div>
  )
}
