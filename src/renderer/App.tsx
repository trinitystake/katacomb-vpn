import { useState, useEffect } from 'react'
import { useWallet } from './hooks/useWallet'
import { useConnection } from './hooks/useConnection'
import { useSessions } from './hooks/useSessions'
import { useReconnect } from './hooks/useReconnect'
import type { ConnectionStatus, SessionInfo } from './types'
import MnemonicInput from './components/MnemonicInput'
import WalletPicker from './components/WalletPicker'
import MapView from './components/MapView'
import NodeTable from './components/NodeTable'
import MultihopView from './components/multihop/MultihopView'
import WalletPanel from './components/WalletPanel'
import ConnectedBar from './components/ConnectedBar'
import IpDisplay from './components/IpDisplay'
import DisconnectButton from './components/DisconnectButton'
import StatusBar from './components/StatusBar'
import RpcBanner from './components/RpcBanner'
import ActiveSessions from './components/ActiveSessions'
import PlansView from './components/plans/PlansView'
import ProviderConsole from './components/provider/ProviderConsole'
import { useProvider } from './hooks/useProvider'
import Settings from './components/Settings'
import BinarySetup from './components/BinarySetup'
import AboutModal from './components/AboutModal'
import { SettingsProvider } from './contexts/SettingsContext'
import { NodesProvider } from './contexts/NodesContext'
import { PlansProvider } from './contexts/PlansContext'
import { ChainDraftProvider, useChainDraft } from './contexts/ChainDraftContext'
import { NavigationProvider, useNavigation, type MainTab } from './contexts/NavigationContext'
import Spinner from './components/Spinner'
import AppLogo from './components/AppLogo'

/**
 * Main took the tunnel down on its own: the session ran out of what it was paid for,
 * the node stopped forwarding, or the tunnel went away. Two shapes: an ordinary notice when
 * internet still works, and a danger-styled one when the kill switch was deliberately
 * left armed — there the user has no connectivity at all until they press Restore, so
 * it must not read as cosmetic. It is its own component only because dismissing needs
 * local state.
 */
function SessionExpiredBanner({ expired }: { expired: ConnectionStatus['expired'] }) {
  const [dismissed, setDismissed] = useState(false)
  const [restoring, setRestoring] = useState(false)
  if (!expired || dismissed) return null

  const node = expired.nodeMoniker || 'the node'

  return (
    <div
      className={`px-5 py-1.5 border-b text-xs flex items-center gap-2 ${
        expired.trafficBlocked
          ? 'bg-danger-subtle border-danger text-danger'
          : 'bg-bg-secondary border-border text-text-secondary'
      }`}
    >
      <span aria-hidden>⚠</span>
      <span className="flex-1">
        {expired.reason === 'dropped' ? (
          <>
            {/* Deliberately names no culprit. The interface going away is explained by a
                local failure (a crash, a resume, something else deleting it) just as well
                as by the node, and the user cannot tell which. Only 'stalled' below has
                evidence: traffic left and nothing came back. */}
            The VPN tunnel closed unexpectedly and was disconnected. Your session is still
            open. Reconnect from the Sessions tab to bring the tunnel back.
          </>
        ) : expired.reason === 'stalled' ? (
          <>
            The tunnel to <span className="font-medium">{node}</span> stopped carrying traffic and
            was disconnected. Your session is still open. Reconnect from the Sessions tab to renew
            the handshake with the node.
          </>
        ) : (
          <>
            Your session on <span className="font-medium">{node}</span>
            {/* Which half of a chain ran out. Both hops are separate nodes on separate
                deposits, so "your session ended" without naming one sends the user off
                to replace whichever they happen to remember. */}
            {expired.chainRole && ` (the ${expired.chainRole} hop of your chain)`} ran out of{' '}
            {expired.reason} and was disconnected.
            {expired.chainRole && ' The other hop is still open, and can be ended from the Sessions tab.'}
          </>
        )}
        {expired.trafficBlocked && ' The kill switch is still blocking all traffic.'}
      </span>
      {expired.trafficBlocked && (
        <button
          onClick={async () => {
            setRestoring(true)
            try {
              await window.api.connectionDisconnect()
            } finally {
              setRestoring(false)
            }
          }}
          disabled={restoring}
          className="btn btn-danger text-xs px-2 py-0.5 disabled:opacity-40"
        >
          {restoring ? <Spinner /> : 'Restore internet'}
        </button>
      )}
      <button
        onClick={() => setDismissed(true)}
        className="hover:text-text-primary transition-colors px-1"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}

/**
 * The DROP-all chain is still installed after a failed teardown, so the user has no
 * internet at all until it comes down. Restarting the app does fix it (the startup
 * self-heal reverts a stranded chain), but it is a poor only-option: the teardown
 * usually fails because a polkit prompt was dismissed or missed, and one more press
 * is all it takes.
 *
 * Retry is just `connectionDisconnect()` again. The armed MARKER is only cleared on a
 * confirmed teardown, so `revertPostConnectSettings` still sees the chain as installed
 * and tries again. Same call the expiry banner's "Restore internet" makes.
 */
function KillSwitchStuckBanner() {
  const [retrying, setRetrying] = useState(false)
  return (
    <div className="px-5 py-1.5 bg-danger-subtle border-b border-danger text-danger text-xs flex items-center gap-2">
      <span aria-hidden>⚠</span>
      <span className="flex-1">
        The kill switch could not be turned off, so all traffic may still be blocked.
        Try again, and allow the password prompt if one appears. If that fails, restart
        Katacomb VPN to restore it.
      </span>
      <button
        onClick={async () => {
          setRetrying(true)
          try {
            await window.api.connectionDisconnect()
          } catch {
            // The banner is still up; the state it reports has not changed.
          } finally {
            setRetrying(false)
          }
        }}
        disabled={retrying}
        className="btn btn-danger text-xs px-2 py-0.5 disabled:opacity-40"
      >
        {retrying ? <Spinner /> : 'Try again'}
      </button>
    </div>
  )
}

/**
 * Written out rather than capitalized from the tab id: "multihop" would render as
 * "Multihop", and the hyphen is what makes it read as two hops rather than a word.
 */
const TAB_LABELS: Record<MainTab, string> = {
  map: 'Map',
  nodes: 'Nodes',
  multihop: 'Multi-hop',
  plans: 'Plans',
  sessions: 'Sessions',
  provider: 'Provider',
}

function AppInner() {
  const wallet = useWallet()
  const { status: connStatus } = useConnection()
  const isConnected = connStatus.state === 'connected' || connStatus.state === 'reconnecting'
  // Whether the chain is out of reach because our own tunnel carries the traffic,
  // which is what isVpnActive() gates the cached-data handlers on in main. Proxy mode
  // is connected but redirects nothing, so the RPC endpoint is still reachable there.
  const chainFrozen = isConnected && !connStatus.proxyMode
  const { mainTab, setMainTab, settingsTab, openSettings, closeSettings } = useNavigation()
  const [showBinarySetup, setShowBinarySetup] = useState(true)
  const [showAbout, setShowAbout] = useState(false)
  // "Add another wallet" from the picker: show the import screen even though
  // wallets are already stored.
  const [addingWallet, setAddingWallet] = useState(false)
  // Clear it once a wallet is live, so a later Lock lands on the picker rather
  // than resuming the add-a-wallet flow the user already finished.
  useEffect(() => {
    if (wallet.address) setAddingWallet(false)
  }, [wallet.address])
  const sessionsState = useSessions()
  // Live sessions only. An ended one is still listed while it settles on chain, but
  // the badge means "this needs you", and a settling row does not.
  const sessionCount = sessionsState.sessions.filter((s) => s.status === 'active').length
  // A parked half-built chain, so it is visible from any tab rather than only from
  // the one the two nodes were picked on.
  const { entry: chainEntry, exit: chainExit } = useChainDraft()
  const chainDraftCount = (chainEntry ? 1 : 0) + (chainExit ? 1 : 0)
  const reconnect = useReconnect()
  // One instance for the whole app: it decides whether the tab exists AND feeds the
  // console, so a refresh from inside the console also updates the tab. Skipped
  // while the tunnel is up — the chain isn't reachable through it.
  // Provider mode is per-wallet, so it comes off the active entry rather than app
  // settings — a newly imported seed must not inherit the previous wallet's tab.
  const activeWallet = wallet.store?.wallets.find((w) => w.id === wallet.store?.activeWalletId)
  const providerState = useProvider(wallet.address, !isConnected, Boolean(activeWallet?.providerMode))
  const providerVisible = providerState.visible
  const mainTabs: MainTab[] = providerVisible
    ? ['map', 'nodes', 'multihop', 'plans', 'sessions', 'provider']
    : ['map', 'nodes', 'multihop', 'plans', 'sessions']

  // Turning provider mode back off while standing on that tab would leave the
  // main area blank — fall back to the map.
  useEffect(() => {
    if (mainTab === 'provider' && !providerVisible) setMainTab('map')
  }, [mainTab, providerVisible, setMainTab])

  // Tray "About": main shows the window, we show the modal. Registered above the
  // early returns so it works on the wallet setup screens too.
  useEffect(() => {
    return window.api.onShowAbout(() => setShowAbout(true))
  }, [])

  // Tray "Connect": reconnect to the most recent session (main already showed the
  // window). If there's none or it fails, the window is open for a manual connect.
  useEffect(() => {
    return window.api.onTrayConnect(async () => {
      try {
        const sessions = (await window.api.walletSessions()) as SessionInfo[]
        if (!sessions?.length) return
        const target = [...sessions].sort(
          (a, b) => new Date(b.startAt || 0).getTime() - new Date(a.startAt || 0).getTime(),
        )[0]
        await reconnect(target)
      } catch { /* window already shown for manual connect */ }
    })
  }, [reconnect])

  if (wallet.loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-text-secondary text-sm flex items-center gap-2">
          <Spinner />
          Initializing...
        </div>
      </div>
    )
  }

  // Three states, not two: seeds can be stored with none active (after Lock, or
  // when the active one couldn't be restored). Showing the import screen there
  // hid the stored wallets, and retyping a seed the app already had is what
  // created duplicate entries for one address.
  if (!wallet.address) {
    const stored = wallet.store?.wallets ?? []
    // A retained seed has no wallets but still belongs in the picker — it's the
    // only screen that can derive from it.
    const hasRetainedSeed = Boolean(wallet.store?.retainedSeedId)
    if ((stored.length > 0 || hasRetainedSeed) && !addingWallet) {
      return (
        <>
          <WalletPicker
            status={wallet.store!}
            onChanged={wallet.refreshIdentity}
            onAddAnother={() => setAddingWallet(true)}
          />
          {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
        </>
      )
    }
    return (
      <>
        <MnemonicInput
          onImport={async (mnemonic, name) => {
            await wallet.importWallet(mnemonic, name)
          }}
          onBackToWallets={stored.length > 0 ? () => setAddingWallet(false) : undefined}
          onUseExisting={async (walletId) => {
            await window.api.walletSwitch(walletId)
            setAddingWallet(false)
            await wallet.refreshIdentity()
          }}
        />
        {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      </>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg-secondary shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <AppLogo size={30} className="shrink-0" />
            <h1 className="text-accent font-semibold text-base">
              Katacomb VPN
            </h1>
          </div>
          <ConnectedBar />
          <IpDisplay connected={isConnected} sessionId={connStatus.sessionId} />
          <DisconnectButton />
        </div>
        <div className="flex items-center gap-3">
          <WalletPanel
            address={wallet.address}
            name={wallet.name}
            onLogout={wallet.logout}
            chainFrozen={chainFrozen}
            walletCount={wallet.store?.wallets.length ?? 0}
          />
          <button
            onClick={() => openSettings()}
            className="text-text-secondary hover:text-accent text-sm transition-colors"
            title="Settings"
          >
            Settings
          </button>
        </div>
      </header>

      <RpcBanner />

      {/* Keyed by session so a dismissal never hides the NEXT session's expiry. */}
      <SessionExpiredBanner key={connStatus.expired?.sessionId} expired={connStatus.expired} />

      {connStatus.killSwitchTeardownFailed && <KillSwitchStuckBanner />}

      {/* Main tabs. Provider is hidden until this wallet opts in (Settings → General)
          or already has a provider registered on chain. */}
      <nav className="flex border-b border-border bg-bg-secondary px-5 shrink-0">
        {mainTabs.map((t) => (
          <button
            key={t}
            onClick={() => setMainTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              mainTab === t
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {TAB_LABELS[t]}
            {t === 'sessions' && sessionCount > 0 && (
              <span className="text-[10px] font-mono bg-accent/15 text-accent px-1.5 py-0.5 rounded-full leading-none">
                {sessionCount}
              </span>
            )}
            {t === 'multihop' && chainDraftCount > 0 && (
              <span className="text-[10px] font-mono bg-accent/15 text-accent px-1.5 py-0.5 rounded-full leading-none">
                {chainDraftCount}/2
              </span>
            )}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-hidden">
        {mainTab === 'map' && <MapView />}
        {mainTab === 'nodes' && <NodeTable />}
        {mainTab === 'multihop' && <MultihopView />}
        {mainTab === 'plans' && <PlansView />}
        {mainTab === 'sessions' && (
          <ActiveSessions
            sessions={sessionsState.sessions}
            loading={sessionsState.loading}
            refreshing={sessionsState.refreshing}
            refresh={sessionsState.refresh}
          />
        )}
        {mainTab === 'provider' && <ProviderConsole {...providerState} />}
      </main>

      <StatusBar onShowAbout={() => setShowAbout(true)} />

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}

      {showBinarySetup && (
        <BinarySetup onDismiss={() => setShowBinarySetup(false)} />
      )}

      {settingsTab && (
        <Settings
          initialTab={settingsTab}
          onClose={closeSettings}
          onWalletSwitch={() => {
            closeSettings()
            // Trigger re-init by refreshing wallet state
            window.location.reload()
          }}
          onWalletsChanged={wallet.refreshIdentity}
        />
      )}
    </div>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <NodesProvider>
        {/* Above the tab for the same reason as ChainDraftProvider: leaving the
            Plans tab must keep the overview, selection and scan results. */}
        <PlansProvider>
          <NavigationProvider>
            {/* Above the tab, not inside it: leaving the Multi-hop tab must keep the
                half-built chain AND the grades it took hundreds of requests to collect. */}
            <ChainDraftProvider>
              <AppInner />
            </ChainDraftProvider>
          </NavigationProvider>
        </PlansProvider>
      </NodesProvider>
    </SettingsProvider>
  )
}
