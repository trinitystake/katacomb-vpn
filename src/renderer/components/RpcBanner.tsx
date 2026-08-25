import { useEffect, useState } from 'react'
import { pickBestRpc, rpcHostLabel, type RpcCandidate } from '../../shared/rpc-health'
import { useRpcHealth } from '../hooks/useRpcHealth'
import { useNavigation } from '../contexts/NavigationContext'
import { useSettings } from '../contexts/SettingsContext'
import Spinner from './Spinner'

/**
 * Names the problem when the blockchain endpoint is unhealthy and, in manual
 * mode, offers the fastest working replacement behind one click.
 *
 * In manual mode it deliberately never switches on its own: the endpoint that
 * reads your balance is the endpoint that broadcasts your payments, so the swap
 * stays an explicit act. In auto mode (Smart RPC) the monitor switches silently
 * on a confirmed fault, so the Switch button is dropped here; a banner that
 * survives in auto mode means the selection found no healthy replacement, and
 * the message alone is the honest thing to show. Hidden for the two states of
 * our own making — 'suspended' (our tunnel carries the traffic) and 'blocked'
 * (our kill switch drops it) — where an unreachable chain is expected rather
 * than broken, and where switching endpoints is the one thing that cannot help.
 */
export default function RpcBanner() {
  const health = useRpcHealth()
  const { openSettings } = useNavigation()
  const { settings, updateSettings } = useSettings()
  const [dismissed, setDismissed] = useState(false)
  const [candidate, setCandidate] = useState<RpcCandidate | null>(null)
  const [switching, setSwitching] = useState(false)

  // Not-yet-loaded settings count as auto, so the Switch button can never
  // flash before the mode is known.
  const auto = settings?.rpcMode !== 'manual'
  const unhealthy = health.state === 'down' || health.state === 'degraded'
  const show = unhealthy && !dismissed

  // A healthy state means any future warning is about a new problem, so the
  // earlier dismissal shouldn't silence it.
  useEffect(() => {
    if (health.state === 'ok') setDismissed(false)
  }, [health.state])

  useEffect(() => {
    if (!show || auto) return
    let cancelled = false
    window.api.rpcProbeAll()
      .then((probed) => {
        if (!cancelled) setCandidate(pickBestRpc(probed, health.endpoint))
      })
      .catch(() => { if (!cancelled) setCandidate(null) })
    return () => { cancelled = true }
  }, [show, auto, health.endpoint])

  if (!show) return null

  async function switchTo(endpoint: string) {
    setSwitching(true)
    try {
      await updateSettings({ rpcEndpoint: endpoint })
    } finally {
      setSwitching(false)
    }
  }

  const host = rpcHostLabel(health.endpoint)
  const down = health.state === 'down'
  const tone = down ? 'bg-danger-subtle border-danger text-danger' : 'bg-warning-subtle border-warning text-warning'

  return (
    <div className={`px-5 py-1.5 border-b text-xs flex items-center gap-3 ${tone}`}>
      <span aria-hidden>⚠</span>
      <span className="flex-1">
        {down
          ? `Can't reach the blockchain at ${host}. Balances, sessions and plans may be out of date, and connecting will fail.`
          : `The blockchain endpoint ${host} is ${health.blockAgeSec !== null && health.blockAgeSec > 120 ? 'behind the chain' : 'responding slowly'}. Data may be stale.`}
      </span>

      {!auto && candidate && (
        <button
          onClick={() => switchTo(candidate.endpoint)}
          disabled={switching}
          className="btn btn-secondary text-xs px-2.5 py-1 disabled:opacity-50 flex items-center gap-1.5 shrink-0"
        >
          {switching && <Spinner />}
          Switch to {rpcHostLabel(candidate.endpoint)}
          {candidate.probe.latencyMs !== null && ` (${candidate.probe.latencyMs}ms)`}
        </button>
      )}

      <button
        onClick={() => openSettings('network')}
        className="hover:underline shrink-0"
      >
        Network settings
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="hover:opacity-70 shrink-0"
        title="Dismiss"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}
