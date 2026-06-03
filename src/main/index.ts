import { app, BrowserWindow, shell, Tray, Menu, nativeImage, dialog } from 'electron'
import { join } from 'path'
import { execSync, execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers, cleanupOnQuit, bootstrapNodesCache, startNodeRefreshTimer, stopNodeRefreshTimer } from './ipc-handlers'
import { killAllTunnels, detectExistingConnection, isVpnActive } from './vpn-manager'
import { listProviders } from './provider-service'
import { isDaemonAvailable } from './daemon-client'

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

function createTrayIcon(): void {
  const icon = nativeImage.createFromPath(getIconPath('32x32.png'))
  tray = new Tray(icon)
  tray.setToolTip('Sentinel dVPN — Disconnected')

  updateTrayMenu()

  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

function updateTrayMenu(): void {
  if (!tray) return

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Window', click: () => { mainWindow?.show(); mainWindow?.focus() } },
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

    if (isVpnActive()) {
      e.preventDefault()

      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: 'question',
        title: 'VPN is Active',
        message: 'You are currently connected to a dVPN node. What would you like to do?',
        buttons: ['Disconnect & Quit', 'Minimize to Tray', 'Cancel'],
        defaultId: 2,
        cancelId: 2,
      })

      if (choice === 0) {
        // Disconnect & Quit
        forceQuit = true
        app.quit()
      } else if (choice === 1) {
        // Minimize to tray
        mainWindow?.hide()
      }
      // choice === 2: Cancel — do nothing
    }
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

app.whenReady().then(() => {
  checkSystemDeps()
  // The root daemon (deb install) handles privileged ops password-free, so the
  // per-op polkit helper + its install prompt are only needed on the fallback
  // path (AppImage / dev).
  if (!isDaemonAvailable()) ensurePolkitSetup()
  detectExistingConnection()
  registerIpcHandlers()
  // Seed node cache from disk so the first window gets instant data via
  // nodesGetCached(), then start the 60s background refresh loop.
  bootstrapNodesCache()
  startNodeRefreshTimer()
  createWindow()
  createTrayIcon()

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
  // Don't quit if VPN is active and user chose to minimize to tray
  if (!isVpnActive()) {
    app.quit()
  }
})

export { mainWindow }
