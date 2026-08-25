import { app, BrowserWindow, shell, Tray, Menu, nativeImage, nativeTheme, dialog, powerMonitor } from 'electron'
import { join } from 'path'
import { execSync, execFile, execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { is } from '@electron-toolkit/utils'
import {
  registerIpcHandlers, cleanupOnQuit, bootstrapNodesCache, startNodeRefreshTimer, stopNodeRefreshTimer,
  performDisconnect, onConnectionStateChanged, getConnectionInfo, healStrandedKillSwitch, type ConnectionInfo,
} from './ipc-handlers'
import { killAllTunnels, detectExistingConnection } from './vpn-manager'
import { onChainPathChanged, runAutoRpcSelection, startRpcMonitor, stopRpcMonitor } from './rpc-monitor'
import { sweepStaleSessionFiles } from './chain-service'
import { migrateLegacyUserData, dedupeWalletEntries, migrateProviderModeToWallet, migrateRpcMode } from './settings'
import { listProviders } from './provider-service'
import { isDaemonAvailable } from './daemon-client'
import { IPC } from '../shared/ipc-channels'

const HELPER_PATH = '/usr/local/bin/katacomb-vpn-helper'
const POLICY_PATH = '/usr/share/polkit-1/actions/com.katacomb.vpn.policy'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let forceQuit = false

// Whether any panel actually DISPLAYS StatusNotifierItems. Stock GNOME (default
// desktop on Debian and Ubuntu) ships no tray at all: new Tray() succeeds, the
// item registers, and nothing is drawn anywhere. Hiding the window "to the tray"
// there makes the app unreachable, so the close handler falls back to quitting.
// Defaults to true so a failed probe preserves the hide-to-tray behavior.
let trayHostAvailable = true

/** Ask the session's StatusNotifierWatcher (over gdbus, which glib ships on every
 *  Debian-based distro) whether a host is registered. Any failure — no watcher on
 *  the bus, no gdbus, timeout — means no visible tray. Async and best-effort: the
 *  answer only matters by the time the user closes the window. */
function probeTrayHost(): void {
  execFile('gdbus', [
    'call', '--session',
    '--dest', 'org.kde.StatusNotifierWatcher',
    '--object-path', '/StatusNotifierWatcher',
    '--method', 'org.freedesktop.DBus.Properties.Get',
    'org.kde.StatusNotifierWatcher', 'IsStatusNotifierHostRegistered',
  ], { timeout: 3000 }, (err, stdout) => {
    trayHostAvailable = !err && stdout.includes('true')
  })
}

function getIconPath(filename: string): string {
  return is.dev
    ? join(__dirname, '../../build/icons', filename)
    : join(process.resourcesPath, 'icons', filename)
}

/** Tray art is kept out of build/icons/ because electron-builder's `linux.icon`
 *  points at that directory and derives the launcher icon set from the PNGs it
 *  finds there — a badged 32x32 must not be a candidate. */
function getTrayIconPath(filename: string): string {
  return is.dev
    ? join(__dirname, '../../build/tray', filename)
    : join(process.resourcesPath, 'tray', filename)
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Tray left-click: toggle the window — hide it if it's showing, otherwise show it. */
function toggleWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide()
    return
  }
  showWindow()
}

/** Tray "Connect": show the window and let the renderer reconnect to the last session. */
function triggerTrayConnect(): void {
  showWindow()
  mainWindow?.webContents.send(IPC.CONNECTION_TRAY_CONNECT)
}

/** Tray "About": show the window and open the renderer's About modal, the same
 *  one the status bar's version chip opens, so there is exactly one About
 *  surface (with the clickable GitHub link a native message box can't render). */
function showAbout(): void {
  showWindow()
  mainWindow?.webContents.send(IPC.ABOUT_SHOW)
}

/** Which of the badged tray icons (build/tray/, see scripts/build-icons.mjs) a
 *  connection state shows. The badge SHAPE carries the state — none / hollow
 *  ring / solid disc — so it survives a greyscale or colour-blind reading; the
 *  colour only reinforces it. */
function trayIconName(state: ConnectionInfo['state']): string {
  if (state === 'connected') return 'connected'
  return state === 'connecting' ? 'connecting' : 'disconnected'
}

/** The tray is a flat single-colour silhouette (no background tile), like its
 *  neighbours in the panel — so unlike the launcher/About icon it needs a
 *  variant per panel theme. Filenames are keyed by the panel they're FOR, which
 *  is exactly what this returns, so there's no inversion to get backwards. */
function trayPanel(): 'dark' | 'light' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** Which tray PNG a state wants right now: state badge + current panel ink. */
function trayIconKeyFor(state: ConnectionInfo['state']): string {
  return `${trayIconName(state)}-${trayPanel()}`
}

/** Load one of the tray PNGs by key (32x32 is the tray size; fall back to 256 if
 *  that file is somehow empty so we never construct a Tray with a blank image —
 *  the broken-image triangle). */
function trayImage(key: string): Electron.NativeImage {
  const icon = nativeImage.createFromPath(getTrayIconPath(`${key}-32x32.png`))
  return icon.isEmpty() ? nativeImage.createFromPath(getTrayIconPath(`${key}-256x256.png`)) : icon
}

// Which tray PNG is currently on the icon, so a repaint that wouldn't change it
// can be skipped. Every setImage is a visible repaint of the panel item, and
// nativeTheme fires 'updated' three times per theme toggle (measured on Cinnamon,
// all three carrying the same value) — painting each one is what made the icon
// blink before settling. Guarding on the filename collapses the burst to the one
// repaint that actually changes something, with no delay added.
let trayIconKey = ''

function createTrayIcon(): void {
  const info = getConnectionInfo()
  trayIconKey = trayIconKeyFor(info.state)
  tray = new Tray(trayImage(trayIconKey))
  tray.on('click', () => toggleWindow())
  refreshTray(info)
  // The user can flip their panel theme without restarting the app; re-pick the
  // ink variant when that happens rather than leaving a light-panel icon up
  // against a freshly-dark one. Repaint on the event itself, not on a timer:
  // shouldUseDarkColors is already updated by the time the event arrives (it
  // leads the first firing by ~60-80ms), so there is nothing to wait for, and
  // any debounce here is latency the user reads as the icon lagging its
  // neighbours. Those neighbours are symbolic icons the panel recolours itself,
  // which we can't match exactly — Tray takes a bitmap, so a swap is the only
  // mechanism available — but the event is as early as Electron will tell us.
  nativeTheme.on('updated', () => refreshTray(getConnectionInfo()))
}

/** Rebuild the tray icon, tooltip + context menu to reflect the current connection state. */
function refreshTray(info: ConnectionInfo): void {
  if (!tray) return
  const connected = info.state === 'connected'
  const connecting = info.state === 'connecting'
  const where = info.nodeMoniker ? ` (${info.nodeMoniker})` : ''
  const status = connected ? `Connected${where}` : connecting ? `Connecting…${where}` : 'Disconnected'

  const iconKey = trayIconKeyFor(info.state)
  if (iconKey !== trayIconKey) {
    tray.setImage(trayImage(iconKey))
    trayIconKey = iconKey
  }
  tray.setToolTip(`Katacomb VPN: ${status}`)

  const contextMenu = Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    // No action while a bring-up is in flight: "Connect" would queue a second
    // one behind the connection lock (this path spends on-chain funds), and
    // "Disconnect" would just block until the connect it is racing finishes.
    ...(connecting
      ? []
      : [connected
        ? { label: 'Disconnect', click: () => { void performDisconnect() } }
        : { label: 'Connect', click: () => triggerTrayConnect() }]),
    { label: 'Show Window', click: () => showWindow() },
    { label: 'About', click: () => showAbout() },
    { type: 'separator' },
    { label: 'Quit', click: () => { forceQuit = true; app.quit() } },
  ])

  tray.setContextMenu(contextMenu)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    // Must match --color-bg-primary (tokens.css) — this paints the window between
    // OS-level creation and first React paint.
    backgroundColor: '#16181d',
    titleBarStyle: 'hiddenInset',
    icon: getIconPath('256x256.png'),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (e) => {
    if (forceQuit) return // Allow quit (from tray menu or app.quit())
    // No desktop shows our tray icon (stock GNOME on Debian/Ubuntu): hiding here
    // would leave the app running with no visible way back in or out. Let the
    // window close; window-all-closed then quits through the normal teardown.
    if (!trayHostAvailable) return
    // Closing the window minimizes to the tray; the app keeps running so the
    // tray Connect/Disconnect menu stays available. Real quit = tray "Quit"
    // (sets forceQuit), whose before-quit handler tears down any active tunnel.
    e.preventDefault()
    mainWindow?.hide()
  })

  // Never open a new window; hand only web/mail links to the OS browser.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const { protocol } = new URL(details.url)
      if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
        shell.openExternal(details.url)
      }
    } catch { /* malformed URL — ignore */ }
    return { action: 'deny' }
  })

  // Lock the renderer to its own origin. The SPA navigates via React state, so
  // a real top-frame navigation is always unwanted — block it (and send any
  // external link to the OS browser instead).
  const rendererOrigin = is.dev && process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).origin
    : null
  // In the packaged app the renderer is loaded via loadFile(), a file:// URL whose
  // .origin is the literal string "null" — never equal to rendererOrigin. That made
  // location.reload() (used e.g. after deleting the active wallet) get silently
  // swallowed below instead of reloading. Compare file:// navigations by filesystem
  // path against our own index.html instead of by origin.
  const indexPath = join(__dirname, '../renderer/index.html')
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let isSameOrigin = false
    try {
      const target = new URL(url)
      isSameOrigin = rendererOrigin !== null && target.origin === rendererOrigin
      if (!isSameOrigin && target.protocol === 'file:') {
        isSameOrigin = fileURLToPath(target) === indexPath
      }
    } catch { /* ignore */ }
    if (isSameOrigin) return // allow dev-server reload/HMR, or reload of our own packaged index.html
    event.preventDefault()
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') shell.openExternal(url)
    } catch { /* ignore */ }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(indexPath)
  }
}

function checkSystemDeps(): void {
  // Only WireGuard tools need to be installed system-wide; v2ray is bundled with the app
  const missing: string[] = []

  try { execSync('which wg-quick', { stdio: 'ignore' }) } catch { missing.push('wireguard-tools') }
  try { execSync('which wg', { stdio: 'ignore' }) } catch { if (!missing.includes('wireguard-tools')) missing.push('wireguard-tools') }

  if (missing.length === 0) return

  const result = dialog.showMessageBoxSync({
    type: 'question',
    title: 'Missing System Dependencies',
    message: `Katacomb VPN requires the following packages:\n\n  ${missing.join(', ')}\n\nInstall them now? (requires admin password)`,
    buttons: ['Install', 'Skip'],
    defaultId: 0,
    cancelId: 1,
  })

  if (result === 0) {
    try {
      execSync(`pkexec apt install -y ${missing.join(' ')}`, { stdio: 'pipe', timeout: 120000 })
    } catch {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Installation Failed',
        message: `Could not install packages. Please run manually:\n\nsudo apt install ${missing.join(' ')}`,
      })
    }
  }
}

function ensurePolkitSetup(): void {
  // Locate resource files — in dev they're in project root, in production in resourcesPath
  const resourceDir = is.dev
    ? join(__dirname, '../../resources/linux')
    : join(process.resourcesPath, 'linux')

  const helperSrc = join(resourceDir, 'katacomb-vpn-helper.sh')
  const policySrc = join(resourceDir, 'com.katacomb.vpn.policy')

  if (!existsSync(helperSrc) || !existsSync(policySrc)) return

  // Check if already installed and up-to-date
  const needsInstall = !existsSync(HELPER_PATH) || !existsSync(POLICY_PATH)
  const needsUpdate = !needsInstall && (
    readFileSync(helperSrc, 'utf-8') !== readFileSync(HELPER_PATH, 'utf-8') ||
    readFileSync(policySrc, 'utf-8') !== readFileSync(POLICY_PATH, 'utf-8')
  )

  if (!needsInstall && !needsUpdate) return

  const dialogMessage = needsInstall
    ? 'Katacomb VPN needs to install a system helper so you don\'t have to enter your password every time you connect or disconnect.\n\nThis is a one-time setup that requires admin authentication.'
    : 'The VPN helper script has been updated and needs to be reinstalled.\n\nThis requires admin authentication.'

  const result = dialog.showMessageBoxSync({
    type: 'question',
    title: needsInstall ? 'VPN Helper Setup' : 'VPN Helper Update',
    message: dialogMessage,
    buttons: [needsInstall ? 'Install' : 'Update', 'Skip'],
    defaultId: 0,
    cancelId: 1,
  })

  if (result !== 0) return

  try {
    // Use execFileSync to avoid shell interpolation of paths
    const script = [
      `cp -- "$1" "$3"`,
      `chmod 755 "$3"`,
      `chown root:root "$3"`,
      `cp -- "$2" "$4"`,
      `chmod 644 "$4"`,
      `chown root:root "$4"`,
    ].join(' && ')

    // Bounded, unlike the rest of this function's blocking. Running before
    // createWindow() is deliberate — the helper has to exist before anything can
    // connect, and the message box above already gates startup on an answer — but
    // this call had no timeout at all, so a polkit prompt that never gets answered
    // (no agent running, dialog swallowed by the WM) blocked the main process
    // forever: no window, no tray, nothing to click, kill it from a terminal. 60s
    // is what runPrivileged allows for the same shape of call, a prompt plus a fast
    // command. Failure here is already survivable: the app falls back to
    // per-operation prompts.
    execFileSync('pkexec', ['sh', '-c', script, '--', helperSrc, policySrc, HELPER_PATH, POLICY_PATH], {
      stdio: 'pipe',
      timeout: 60000,
    })
  } catch {
    // User cancelled or pkexec failed — app still works with per-operation prompts
  }
}

// Single-instance lock. A second instance would race the first over the sntl0
// interface, the daemon socket, the kill-switch chain and the settings/wallet
// files. The loser exits at once and focuses the winner's window.
// app.exit (not app.quit) on purpose: app.quit() fires our before-quit handler,
// which tears down the *shared* tunnel — the primary's connection must survive.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => showWindow())
}

// Chromium 146 (Electron 41) no longer falls back to software WebGL on its own.
// On a machine with no usable GPU — a VM without 3D acceleration, a VNC/xrdp
// session, a driver Chromium blocklists — canvas.getContext('webgl2') and
// ('webgl') both return null, silently and with no console warning. That is what
// the Map tab's three.js renderer turns into a thrown "Error creating WebGL
// context.", and since 'map' is the default tab it used to reach the root
// ErrorBoundary and blank the whole client at startup (GitHub issue: user saw
// "Something went wrong / Error creating WebGL context" right after wallet setup,
// on 0.1.1, which shipped this same Electron).
//
// The switch only *permits* the SwiftShader fallback, it does not force it:
// measured on a working Intel GPU, the renderer is still hardware ANGLE with the
// flag set. It has to be set before whenReady, which is also why this is
// unconditional — app.getGPUFeatureStatus() is only readable after ready, too
// late to append a command-line switch.
//
// "unsafe" in the flag name refers to running shaders from *untrusted web
// content* on a software rasterizer. This renderer only ever loads our own
// bundle: setWindowOpenHandler denies every new window, will-navigate is locked
// to our own index.html, and there is no webview. MapView still degrades
// gracefully if a context is refused anyway.
app.commandLine.appendSwitch('enable-unsafe-swiftshader')

app.whenReady().then(() => {
  // Must run before anything touches userData (sweepStaleSessionFiles, settings,
  // the wallet store): the rename moved the directory, so this brings the user's
  // profile across from the pre-rename location.
  migrateLegacyUserData()
  // Repair installs that predate the uniqueness guard in addWalletEntry, where
  // re-importing a stored seed created a second entry for the same address.
  dedupeWalletEntries()
  // Provider mode used to be global, so it leaked onto every seed imported after
  // it was turned on. Runs after the dedupe, which can rewrite activeWalletId.
  migrateProviderModeToWallet()
  // Smart RPC: a pre-feature custom endpoint becomes an explicit 'manual' choice.
  // Must precede any saveSettings, which would bake the 'auto' default in.
  migrateRpcMode()
  checkSystemDeps()
  // The root daemon (deb install) handles privileged ops password-free, so the
  // per-op polkit helper + its install prompt are only needed on the fallback
  // path (AppImage / dev).
  if (!isDaemonAvailable()) ensurePolkitSetup()
  detectExistingConnection()
  // If a previous run left a kill-switch chain stranded (crash/OOM mid-teardown),
  // clear it now that we know we're not connected. Fire-and-forget, best-effort.
  // Re-probe when it lands: until then the monitor reports the chain as blocking
  // (correctly — nothing gets out), and this is what tells it that stopped being
  // true. Not awaited before starting the monitor, because on the pkexec path the
  // heal can sit on a password prompt for as long as the user takes.
  void healStrandedKillSwitch()
    .catch(() => { /* best-effort self-heal */ })
    .finally(() => { onChainPathChanged() })
  // Drop stale session credential files left by non-endSession exit paths (finding L4).
  sweepStaleSessionFiles()
  registerIpcHandlers()
  // Seed node cache from disk so the first window gets instant data via
  // nodesGetCached(), then start the 60s background refresh loop.
  bootstrapNodesCache()
  startNodeRefreshTimer()
  // Watch the RPC endpoint every chain call depends on, so an unhealthy one is
  // visible in the status bar instead of showing up as silently stale data.
  startRpcMonitor()
  // Answer "does this desktop draw tray icons at all?" before the user can close
  // the window; the close handler falls back to quitting when it doesn't.
  probeTrayHost()
  createWindow()
  createTrayIcon()
  // Keep the tray tooltip + menu in sync with connect/disconnect (incl. from the
  // renderer, auto-reconnect, or the tray itself).
  onConnectionStateChanged(refreshTray)

  // Background prefetch so the Plans tab feels instant on first open.
  // Safely returns cached data if VPN is already active.
  setTimeout(() => {
    listProviders().catch(() => {
      // silent — best-effort warmup
    })
  }, 500)

  // Smart RPC's startup pass: probe the public feed once and settle on the best
  // endpoint. Delayed so it doesn't compete with startup, and so the kill-switch
  // heal above has usually cleared a stranded chain first (the selection skips
  // itself while the path is blocked or an adopted tunnel is up, in which case
  // the on-fault trigger covers the rest of the session).
  setTimeout(() => { void runAutoRpcSelection() }, 3_000)

  // Smart RPC on wake: a resumed laptop is often on a different network, where
  // the endpoint chosen before suspend is still healthy but now far away, a
  // state no fault trigger will ever notice. Delayed for the network to
  // re-associate; a run that finds no network yet keeps the current endpoint,
  // and the monitor's fault trigger covers whatever settles later.
  powerMonitor.on('resume', () => {
    setTimeout(() => { void runAutoRpcSelection() }, 8_000)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

let quitHandled = false
app.on('before-quit', (e) => {
  // Destroy the tray the moment quitting starts, on every path: menu Quit,
  // SIGTERM and Ctrl+C all arrive here (Chromium routes signals into the quit
  // flow — verified live). destroy() unregisters the StatusNotifierItem over
  // D-Bus; the app.exit(0) below just drops the bus connection and leaves
  // removal to the panel noticing the name vanish, which is the step that
  // occasionally fails and strands a dead "ghost" icon in the panel.
  tray?.destroy()
  tray = null
  if (quitHandled) {
    // A repeat quit (second menu Quit, double Ctrl+C) must not fall through to
    // the default quit path: that exits at once, cutting the in-flight teardown
    // below mid-way. The already-scheduled app.exit(0) finishes the job.
    e.preventDefault()
    return
  }
  // Teardown is now async (it may round-trip to the root daemon), so defer the
  // quit until it finishes — capped so an unresponsive daemon can't hang the
  // exit. The kernel-resident kill switch/routes survive regardless.
  e.preventDefault()
  quitHandled = true
  stopNodeRefreshTimer()
  stopRpcMonitor()
  void (async () => {
    await Promise.race([
      (async () => {
        try { await cleanupOnQuit() } catch { /* best-effort */ }
        try { await killAllTunnels() } catch { /* best-effort */ }
      })(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
    app.exit(0)
  })()
})

app.on('window-all-closed', () => {
  // With no tray host on this desktop (stock GNOME), the closed window was the
  // only control surface left — quit rather than linger headless.
  if (!trayHostAvailable) {
    app.quit()
    return
  }
  // Otherwise: the app lives in the tray (closing the window only hides it).
  // Quitting is done explicitly via the tray "Quit" item, which sets
  // forceQuit + app.quit().
})

export { mainWindow }
