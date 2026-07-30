import { app, BrowserWindow, shell, Tray, Menu, nativeImage, dialog } from 'electron'
import { join } from 'path'
import { execSync, execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import {
  registerIpcHandlers, cleanupOnQuit, bootstrapNodesCache, startNodeRefreshTimer, stopNodeRefreshTimer,
  performDisconnect, onConnectionStateChanged, getConnectionInfo, healStrandedKillSwitch, type ConnectionInfo,
} from './ipc-handlers'
import { killAllTunnels, detectExistingConnection } from './vpn-manager'
import { sweepStaleSessionFiles } from './sentinel-service'
import { listProviders } from './provider-service'
import { isDaemonAvailable } from './daemon-client'
import { IPC } from '../shared/ipc-channels'

const HELPER_PATH = '/usr/local/bin/sentinel-vpn-helper'
const POLICY_PATH = '/usr/share/polkit-1/actions/com.sentinel.dvpn.policy'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let forceQuit = false

function getIconPath(filename: string): string {
  return is.dev
    ? join(__dirname, '../../build/icons', filename)
    : join(process.resourcesPath, 'icons', filename)
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

function showAbout(): void {
  const aboutIcon = nativeImage.createFromPath(getIconPath('256x256.png'))
  dialog.showMessageBox({
    type: 'info',
    title: 'About Sentinel dVPN',
    message: 'Sentinel dVPN',
    detail: `Version ${app.getVersion()}\n\nDecentralized VPN client for the Sentinel network.\n\nhttps://sentinel.co`,
    icon: aboutIcon.isEmpty() ? undefined : aboutIcon,
    buttons: ['OK'],
  })
}

function createTrayIcon(): void {
  // 32x32 is the tray size; fall back to 256 if that file is somehow empty so we
  // never construct a Tray with a blank image (the broken-image triangle).
  let icon = nativeImage.createFromPath(getIconPath('32x32.png'))
  if (icon.isEmpty()) icon = nativeImage.createFromPath(getIconPath('256x256.png'))
  tray = new Tray(icon)
  tray.on('click', () => toggleWindow())
  refreshTray(getConnectionInfo())
}

/** Rebuild the tray tooltip + context menu to reflect the current connection state. */
function refreshTray(info: ConnectionInfo): void {
  if (!tray) return
  const connected = info.state === 'connected'
  const where = info.nodeMoniker ? ` (${info.nodeMoniker})` : ''

  tray.setToolTip(connected ? `Sentinel dVPN — Connected${where}` : 'Sentinel dVPN — Disconnected')

  const contextMenu = Menu.buildFromTemplate([
    { label: connected ? `Connected${where}` : 'Disconnected', enabled: false },
    { type: 'separator' },
    connected
      ? { label: 'Disconnect', click: () => { void performDisconnect() } }
      : { label: 'Connect', click: () => triggerTrayConnect() },
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
    backgroundColor: '#0a0a0f',
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
    // Closing the window always minimizes to the tray; the app keeps running so
    // the tray Connect/Disconnect menu stays available. Real quit = tray "Quit"
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
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let isSameOrigin = false
    try { isSameOrigin = rendererOrigin !== null && new URL(url).origin === rendererOrigin } catch { /* ignore */ }
    if (isSameOrigin) return // allow dev-server reload/HMR
    event.preventDefault()
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') shell.openExternal(url)
    } catch { /* ignore */ }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
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
    message: `Sentinel dVPN requires the following packages:\n\n  ${missing.join(', ')}\n\nInstall them now? (requires admin password)`,
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

  const helperSrc = join(resourceDir, 'sentinel-vpn-helper.sh')
  const policySrc = join(resourceDir, 'com.sentinel.dvpn.policy')

  if (!existsSync(helperSrc) || !existsSync(policySrc)) return

  // Check if already installed and up-to-date
  const needsInstall = !existsSync(HELPER_PATH) || !existsSync(POLICY_PATH)
  const needsUpdate = !needsInstall && (
    readFileSync(helperSrc, 'utf-8') !== readFileSync(HELPER_PATH, 'utf-8') ||
    readFileSync(policySrc, 'utf-8') !== readFileSync(POLICY_PATH, 'utf-8')
  )

  if (!needsInstall && !needsUpdate) return

  const dialogMessage = needsInstall
    ? 'Sentinel dVPN needs to install a system helper so you don\'t have to enter your password every time you connect or disconnect.\n\nThis is a one-time setup that requires admin authentication.'
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

    execFileSync('pkexec', ['sh', '-c', script, '--', helperSrc, policySrc, HELPER_PATH, POLICY_PATH], { stdio: 'pipe' })
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

app.whenReady().then(() => {
  checkSystemDeps()
  // The root daemon (deb install) handles privileged ops password-free, so the
  // per-op polkit helper + its install prompt are only needed on the fallback
  // path (AppImage / dev).
  if (!isDaemonAvailable()) ensurePolkitSetup()
  detectExistingConnection()
  // If a previous run left a kill-switch chain stranded (crash/OOM mid-teardown),
  // clear it now that we know we're not connected. Fire-and-forget, best-effort.
  void healStrandedKillSwitch().catch(() => { /* best-effort self-heal */ })
  // Drop stale session credential files left by non-endSession exit paths (finding L4).
  sweepStaleSessionFiles()
  registerIpcHandlers()
  // Seed node cache from disk so the first window gets instant data via
  // nodesGetCached(), then start the 60s background refresh loop.
  bootstrapNodesCache()
  startNodeRefreshTimer()
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

let quitHandled = false
app.on('before-quit', (e) => {
  if (quitHandled) return
  // Teardown is now async (it may round-trip to the root daemon), so defer the
  // quit until it finishes — capped so an unresponsive daemon can't hang the
  // exit. The kernel-resident kill switch/routes survive regardless.
  e.preventDefault()
  quitHandled = true
  stopNodeRefreshTimer()
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
  // No-op: the app lives in the tray (closing the window only hides it). Quitting
  // is done explicitly via the tray "Quit" item, which sets forceQuit + app.quit().
})

export { mainWindow }
