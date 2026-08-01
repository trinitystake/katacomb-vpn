import { useState, useEffect } from 'react'
import { useWallet } from './hooks/useWallet'
import { useConnection } from './hooks/useConnection'
import { useSessions } from './hooks/useSessions'
import { useReconnect } from './hooks/useReconnect'
import type { SessionInfo } from './types'
import MnemonicInput from './components/MnemonicInput'
import WalletPicker from './components/WalletPicker'
import MapView from './components/MapView'
import NodeTable from './components/NodeTable'
import WalletPanel from './components/WalletPanel'
import ConnectedBar from './components/ConnectedBar'
import IpDisplay from './components/IpDisplay'
import DisconnectButton from './components/DisconnectButton'
import StatusBar from './components/StatusBar'
import RpcBanner from './components/RpcBanner'
import ActiveSessions from './components/ActiveSessions'
import PlanDiscovery from './components/PlanDiscovery'
import ProviderConsole from './components/provider/ProviderConsole'
import { useProvider } from './hooks/useProvider'
import Settings from './components/Settings'
import BinarySetup from './components/BinarySetup'
import { SettingsProvider } from './contexts/SettingsContext'
import { NodesProvider } from './contexts/NodesContext'
import { NavigationProvider, useNavigation, type MainTab } from './contexts/NavigationContext'
import Spinner from './components/Spinner'
import AppLogo from './components/AppLogo'

function AppInner() {
  const wallet = useWallet()
  const { status: connStatus } = useConnection()
  const isConnected = connStatus.state === 'connected' || connStatus.state === 'reconnecting'
  const { mainTab, setMainTab, settingsTab, openSettings, closeSettings } = useNavigation()
  const [showBinarySetup, setShowBinarySetup] = useState(true)
  // "Add another wallet" from the picker: show the import screen even though
  // wallets are already stored.
  const [addingWallet, setAddingWallet] = useState(false)
  // Clear it once a wallet is live, so a later Lock lands on the picker rather
  // than resuming the add-a-wallet flow the user already finished.
  useEffect(() => {
    if (wallet.address) setAddingWallet(false)
  }, [wallet.address])
  const sessionsState = useSessions()
  const sessionCount = sessionsState.sessions.length
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
    ? ['map', 'nodes', 'plans', 'sessions', 'provider']
    : ['map', 'nodes', 'plans', 'sessions']

  // Turning provider mode back off while standing on that tab would leave the
  // main area blank — fall back to the map.
  useEffect(() => {
    if (mainTab === 'provider' && !providerVisible) setMainTab('map')
  }, [mainTab, providerVisible, setMainTab])

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
        <WalletPicker
          status={wallet.store!}
          onChanged={wallet.refreshIdentity}
          onAddAnother={() => setAddingWallet(true)}
        />
      )
    }
    return (
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
          <IpDisplay connected={isConnected} />
          <DisconnectButton />
        </div>
        <div className="flex items-center gap-3">
          <WalletPanel
            address={wallet.address}
            name={wallet.name}
            onLogout={wallet.logout}
            connected={isConnected}
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

      {connStatus.killSwitchTeardownFailed && (
        <div className="px-5 py-1.5 bg-danger-subtle border-b border-danger text-danger text-xs flex items-center gap-2">
          <span aria-hidden>⚠</span>
          <span>
            The kill switch could not be turned off — all traffic may still be blocked.
            If you have no internet, restart Katacomb VPN to restore it.
          </span>
        </div>
      )}

      {/* Main tabs. Provider is hidden until this wallet opts in (Settings → General)
          or already has a provider registered on chain. */}
      <nav className="flex border-b border-border bg-bg-secondary px-5 shrink-0">
        {mainTabs.map((t) => (
          <button
            key={t}
            onClick={() => setMainTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize flex items-center gap-1.5 ${
              mainTab === t
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t}
            {t === 'sessions' && sessionCount > 0 && (
              <span className="text-[10px] font-mono bg-accent/15 text-accent px-1.5 py-0.5 rounded-full leading-none">
                {sessionCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-hidden">
        {mainTab === 'map' && <MapView />}
        {mainTab === 'nodes' && <NodeTable />}
        {mainTab === 'plans' && <PlanDiscovery />}
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

      <StatusBar />

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
        <NavigationProvider>
          <AppInner />
        </NavigationProvider>
      </NodesProvider>
    </SettingsProvider>
  )
}
