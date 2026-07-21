import { useCallback } from 'react'
import type { SessionInfo } from '../types'

export interface ReconnectOutcome {
  ok: boolean
  error?: string
}

/**
 * Reconnect to an existing session using its saved tunnel config — the same flow
 * as the Session tab's Connect button (reconnect → connect). Shared by
 * ActiveSessions and the tray "Connect" handler. Connection status updates arrive
 * via the CONNECTION_STATE_CHANGE broadcast (see useConnection), so callers don't
 * need to poll afterwards.
 */
export function useReconnect(): (session: SessionInfo) => Promise<ReconnectOutcome> {
  return useCallback(async (session: SessionInfo): Promise<ReconnectOutcome> => {
    try {
      const res = await window.api.connectionReconnect({ sessionId: session.id })
      await window.api.connectionConnect({
        protocol: res.protocol as 'wireguard' | 'v2ray' | 'xray' | 'hysteria2',
        configString: res.configString,
      })
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Reconnection failed'
      if (msg.includes('No saved config')) {
        return {
          ok: false,
          error: `Session #${session.id}: No saved tunnel config. You can end this session to free it, then create a new subscription.`,
        }
      }
      return { ok: false, error: msg }
    }
  }, [])
}
