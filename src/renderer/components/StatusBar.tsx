import { useConnection } from '../hooks/useConnection'
import { useNodeTest } from '../hooks/useNodeTest'
import TrafficStats from './TrafficStats'
import Spinner from './Spinner'

export default function StatusBar() {
  const { status } = useConnection()
  const { speedResult, speedTesting, testSpeed } = useNodeTest()
  const connected = status.state === 'connected'

  if (!connected) return null

  return (
    <footer className="flex items-center justify-end gap-3 px-5 py-1.5 border-t border-border bg-bg-secondary shrink-0 text-xs">
      <TrafficStats connected={connected} />

      {speedTesting ? (
        <span className="text-text-tertiary flex items-center gap-1">
          <Spinner className="text-accent" /> Testing...
        </span>
      ) : speedResult ? (
        <span className="text-text-secondary font-mono">
          {speedResult.downloadMbps > 0 && (
            <span className="text-success">{speedResult.downloadMbps} Mbps</span>
          )}
          {speedResult.googleLatencyMs !== null && (
            <span className={speedResult.googleReachable ? 'text-success' : 'text-danger'}>
              {speedResult.downloadMbps > 0 ? ' · ' : ''}Google: {speedResult.googleLatencyMs}ms
            </span>
          )}
          {speedResult.error && !speedResult.downloadMbps && (
            <span className="text-danger">Failed</span>
          )}
        </span>
      ) : null}

      <button
        onClick={testSpeed}
        disabled={speedTesting}
        className="text-text-secondary hover:text-accent text-xs transition-colors disabled:opacity-30"
      >
        {speedResult ? 'Retest' : 'Speed Test'}
      </button>
    </footer>
  )
}
