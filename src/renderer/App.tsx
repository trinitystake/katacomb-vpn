import { useState } from 'react'
import { useWallet } from './hooks/useWallet'
import { useConnection } from './hooks/useConnection'
import { useSessions } from './hooks/useSessions'
import MnemonicInput from './components/MnemonicInput'
import MapView from './components/MapView'
import NodeTable from './components/NodeTable'
import WalletPanel from './components/WalletPanel'
import ConnectedBar from './components/ConnectedBar'
import IpDisplay from './components/IpDisplay'
import ActiveSessions from './components/ActiveSessions'
import PlanDiscovery from './components/PlanDiscovery'
import Settings from './components/Settings'
import BinarySetup from './components/BinarySetup'
import { SettingsProvider } from './contexts/SettingsContext'
import { NodesProvider } from './contexts/NodesContext'
import { NavigationProvider, useNavigation } from './contexts/NavigationContext'
import Spinner from './components/Spinner'
import appIcon from './assets/sentinel.svg'

function AppInner() {
  const wallet = useWallet()
  const { status: connStatus } = useConnection()
  const isConnected = connStatus.state === 'connected' || connStatus.state === 'reconnecting'
  const [showSettings, setShowSettings] = useState(false)
  const { mainTab, setMainTab } = useNavigation()
  const [showBinarySetup, setShowBinarySetup] = useState(true)
  const sessionsState = useSessions()
  const sessionCount = sessionsState.sessions.length

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

  if (!wallet.address) {
    return (
      <MnemonicInput
        onImport={async (mnemonic, name) => {
          await wallet.importWallet(mnemonic, name)
        }}
      />
    )
  }

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg-secondary shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <img src={appIcon} alt="" width={22} height={22} className="shrink-0" />
            <h1 className="text-accent font-semibold text-base">
              Sentinel dVPN
            </h1>
          </div>
          <ConnectedBar />
          <IpDisplay connected={isConnected} />
        </div>
        <div className="flex items-center gap-3">
          <WalletPanel address={wallet.address} name={wallet.name} onLogout={wallet.logout} />
          <button
            onClick={() => setShowSettings(true)}
            className="text-text-secondary hover:text-accent text-sm transition-colors"
            title="Settings"
          >
            Settings
          </button>
        </div>
      </header>

      {/* Main tabs */}
      <nav className="flex border-b border-border bg-bg-secondary px-5 shrink-0">
        {(['map', 'nodes', 'plans', 'sessions'] as const).map((t) => (
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
      </main>

      {showBinarySetup && (
        <BinarySetup onDismiss={() => setShowBinarySetup(false)} />
      )}

      {showSettings && (
        <Settings
          currentAddress={wallet.address}
          onClose={() => setShowSettings(false)}
          onWalletSwitch={() => {
            setShowSettings(false)
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
