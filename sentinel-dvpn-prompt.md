## Role & Expertise

You are a senior full-stack engineer specializing in decentralized networking, Cosmos SDK blockchain integration, and Linux desktop application development. You have deep expertise in the Sentinel dVPN protocol, WireGuard/V2Ray VPN tunneling, and Electron-based desktop apps. You write production-grade TypeScript, handle cryptographic material responsibly, and architect for security-first.

---

## Objective

Build a **fully functional Linux desktop application** that connects to the **Sentinel P2P dVPN network** using the official JavaScript SDK. The app must allow a user to import a Cosmos wallet via mnemonic, browse available dVPN nodes, subscribe to a node (by gigabytes or hours), perform a cryptographic handshake, and establish a live VPN tunnel (V2Ray or WireGuard).

---

## Technology Stack (Mandatory)

| Layer | Technology | Reason |
|---|---|---|
| **Desktop shell** | **Electron** (latest stable) | Native access for WireGuard `sudo`, tray icon, system keyring via `safeStorage` |
| **Renderer framework** | **React 18 + TypeScript** | Component model, hooks for async blockchain state |
| **Build tooling** | **Vite** (with `electron-vite` or `electron-forge` + Vite plugin) | Fast HMR, native module support |
| **Blockchain SDK** | `@sentinel-official/sentinel-js-sdk` (latest on npm) | Sentinel-specific Cosmos client, protobuf messages, handshake helpers |
| **Cosmos signing** | `@cosmjs/proto-signing`, `@cosmjs/stargate` | Wallet derivation, gas, tx broadcast |
| **Secure storage** | Electron `safeStorage` API (encrypts via OS keyring: libsecret on Linux) | Encrypt mnemonic at rest — no plaintext on disk, no `node-keytar` native dep |
| **Node list API** | `https://api.sentnodes.com/v2/nodes` (REST) | Pre-indexed, fast node discovery with health/country/pricing metadata |
| **RPC endpoint** | `https://rpc.sentinel.co:443` | On-chain queries & tx broadcast |
| **VPN protocols** | SDK's `V2Ray` and `Wireguard` classes | Handshake + tunnel management built into sentinel-js-sdk |
| **Styling** | Tailwind CSS 3 | Utility-first, easy to achieve the cypherpunk aesthetic |
| **Country flags** | `country-flag-emoji-polyfill` or SVG flag sprites (e.g. `flag-icons`) | Visual country indicators in the node table |
| **QR codes** | `qrcode` npm package (for WireGuard config export) | Show scannable WG config |

---

## Reference Material — READ THESE FIRST

Before writing any code, fetch and study each of the following. They are your primary sources of truth:

1. **SDK documentation (TypeDoc)**  
   `https://sentinel-official.github.io/sentinel-js-sdk/`  
   — Covers `SentinelClient`, `SigningSentinelClient`, query modules (`node`, `session`, `subscription`, `plan`, `provider`), tx helpers (`nodeStartSession`, `searchEvent`, `NodeEventCreateSession`), and the `Wireguard` / `V2Ray` classes.

2. **Node.js example (canonical usage pattern)**  
   `https://github.com/sentinel-official/sentinel-js-sdk/blob/main/examples/node/main.ts`  
   — Shows the full flow: mnemonic → wallet → query node → subscribe (gigabytes) → handshake → V2Ray connect / WireGuard QR. **Follow this flow exactly** as the backbone of the connection logic.

3. **SDK GitHub repo (package.json, src/ structure, dist/)**  
   `https://github.com/sentinel-official/sentinel-js-sdk`  
   — Check exported types, confirm import paths, review the `Wireguard` and `V2Ray` helper class APIs.

4. **Node list REST API**  
   `https://api.sentnodes.com/v2/nodes`  
   — Returns `{ success: boolean, data: Node[] }`. Each node object contains:
   ```
   address, moniker, version, type (1=wireguard, 2=v2ray),
   api, asn, country, city, isResidential, isActive, isHealthy,
   isDuplicate, isWhitelisted, gigabytePrices[], hourlyPrices[],
   leases, sessions, peers, errorMessage, fetchedAt
   ```
   Price objects: `{ denom: string, value: string }`. The `udvpn` denom is the native token.

5. **Cosmos balance query**  
   REST: `GET /cosmos/bank/v1beta1/balances/{address}` against an LCD endpoint, or  
   use CosmJS: `StargateClient.getAllBalances(address)` (which `SentinelClient` extends).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                 Electron Main Process            │
│                                                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ Wallet   │  │ Sentinel  │  │  VPN Tunnel  │  │
│  │ Manager  │  │ Service   │  │  Manager     │  │
│  │(safeStore│  │(SDK+RPC)  │  │(WG/V2Ray)    │  │
│  └──────────┘  └───────────┘  └──────────────┘  │
│         ▲            ▲              ▲            │
│         │    IPC (contextBridge)    │            │
│         ▼            ▼              ▼            │
│  ┌─────────────────────────────────────────────┐ │
│  │           Preload Script (API bridge)       │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
                       ▲
                       │ contextBridge.exposeInMainWorld
                       ▼
┌─────────────────────────────────────────────────┐
│              Electron Renderer (React)           │
│                                                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ Login /  │  │ Node      │  │ Connection   │  │
│  │ Wallet   │  │ Browser   │  │ Status       │  │
│  │ Screen   │  │ + Filters │  │ Dashboard    │  │
│  └──────────┘  └───────────┘  └──────────────┘  │
└─────────────────────────────────────────────────┘
```

**Security rules:**
- Mnemonic and private key NEVER leave the main process.
- Renderer communicates ONLY via typed IPC channels exposed through `contextBridge`.
- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` on the BrowserWindow.

---

## Detailed Feature Specification

### 1. Wallet Import & Secure Storage

**On first launch (no stored wallet):**
- Show a full-screen mnemonic input form (single `<textarea>`, monospace font, dark bg).
- Validate: must be a valid BIP-39 mnemonic. Show inline error if invalid.
- On submit:
  1. `DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "sent" })`
  2. `const [account] = await wallet.getAccounts()` → derive `sent1…` address.
  3. `const privkey = await privKeyFromMnemonic({ mnemonic: wallet.mnemonic })` — needed for handshake signing.
  4. Encrypt mnemonic using `safeStorage.encryptString(mnemonic)` → store the resulting Buffer in a local JSON file (`~/.config/sentinel-dvpn-app/wallet.enc`).
  5. Transition to the main dashboard.

**On subsequent launches (stored wallet found):**
- Read the encrypted blob → `safeStorage.decryptString(buffer)` → reconstruct wallet + privkey in memory.
- If decryption fails (OS keyring changed), prompt to re-enter mnemonic.

**Logout / Reset:** Delete `wallet.enc`, clear in-memory keys, return to mnemonic screen.

### 2. Node Browser

**Data source:** `GET https://api.sentnodes.com/v2/nodes`

**Table columns:**
| Column | Content |
|---|---|
| Flag + Country | Country flag emoji/SVG + country name |
| City | City name |
| Moniker | Node name |
| Type | "V2Ray" or "WireGuard" (derived from `type`: 1=WG, 2=V2Ray) |
| Price (DVPN/GB) | `gigabytePrices` where `denom === "udvpn"`, divide value by 1e6 to show DVPN |
| Price (DVPN/hr) | `hourlyPrices` where `denom === "udvpn"`, divide value by 1e6 to show DVPN |
| Peers | `peers` count |
| Status | Green/red dot based on `isActive && isHealthy` |

**Filters (top bar, compact):**
- Country (searchable dropdown)
- City (searchable dropdown, filters when country selected)
- Type: WireGuard / V2Ray / All
- Toggles: Active Only, Healthy Only, Residential Only, Whitelisted Only, Hide Duplicates
- Text search: filter by moniker

**Sorting:** Click column headers to sort asc/desc.

**Pagination / virtual scroll:** The node list can be large (5000+). Use virtualized rendering (`react-window` or `@tanstack/react-virtual`) so the table stays fast.

**Auto-refresh:** Re-fetch node list every 60 seconds. Show last-fetched timestamp.

### 3. Node Connection Flow

When user clicks a node row → open a **connection modal/panel**:

1. **Display node details:** address, moniker, country, city, type, version, prices.

2. **Subscription type selector:**
   - Radio: "Pay by Gigabytes" / "Pay by Hours"
   - Numeric input: amount of GB or hours
   - Show calculated cost in DVPN (amount × unit price from `udvpn` denom)
   - Show current wallet balance for comparison

3. **"Subscribe & Connect" button:**
   Executes the following sequence (show progress steps in the UI):

   ```
   Step 1/5: Creating signing client...
   → SigningSentinelClient.connectWithSigner(rpc, wallet, { gasPrice })

   Step 2/5: Broadcasting subscription transaction...
   → Build TxNodeStartSession (gigabytes OR hours, with maxPrice from udvpn denom)
   → client.signAndBroadcast(address, [nodeStartSession(args)], "auto", "sentinel-dvpn-app")
   → assertIsDeliverTxSuccess(tx)

   Step 3/5: Extracting session ID...
   → searchEvent(NodeEventCreateSession.type, tx.events)
   → NodeEventCreateSession.parse(event) → sessionId

   Step 4/5: Performing handshake with node...
   → If V2Ray: new V2Ray(), handshake(sessionId, { uuid: v2ray.getKey() }, privkey, remoteAddr)
   → If WireGuard: new Wireguard(), handshake(sessionId, { public_key: wg.publicKey }, privkey, remoteAddr)

   Step 5/5: Establishing VPN tunnel...
   → V2Ray: v2ray.parseConfig(handshakeData, addrs) → v2ray.connect() → show proxy details (protocol, listen, port)
   → WireGuard: wg.parseConfig(handshakeData, addrs) → ask user: "Show QR Code" or "Connect now"
     - "Show QR": generate QR from WG config string
     - "Connect now": wg.connect() (requires pkexec/sudo — Electron spawns with elevated privileges)
   ```

4. **Important notes on `remoteAddr`:**
   - The example uses `p2pNode.node.remoteAddrs[0]` for the handshake endpoint.
   - When using the sentnodes API (instead of on-chain query), you get the `api` field (e.g., `"elpis.busur.cc:63116"`). You may need to query the node on-chain via `client.sentinelQuery?.node.node(sentnode)` to get `remoteAddrs`, OR construct the URL from the `api` field as `https://{api}` — **check the SDK source to confirm which format `handshake()` expects** and handle accordingly.

### 4. Connection Status Dashboard

Once connected, show:
- **Connection status:** Connected / Disconnected, with a pulsing green/red indicator
- **Connected node:** moniker, country+flag, type
- **Session ID** 
- **Protocol details:** For V2Ray, show each inbound (protocol + listen:port). For WG, show tunnel interface.
- **Disconnect button:** V2Ray → `v2ray.disconnect()`. WireGuard → tear down interface.
- **Wallet balance:** Query via `SentinelClient.connect(rpc)` then `client.getAllBalances(address)` — show DVPN balance prominently. Refresh every 30 seconds.

### 5. Wallet Info Sidebar / Panel

- **Address:** `sent1…` (with copy button)
- **Balance:** DVPN amount (from `getAllBalances`, filter for `udvpn` denom, divide by 1e6)
- **Active sessions:** Query on-chain via `client.sentinelQuery?.session.sessionsForAddress(address, ...)` if available
- **Refresh button**

---

## UI / UX Design Specification — Cypherpunk Aesthetic

The visual language is **cypherpunk/terminal-noir**: think dark terminals, monospace text, phosphor greens, minimal chrome, raw data visibility.

### Color Palette (CSS variables)
```css
:root {
  --bg-primary: #0a0a0f;        /* Near-black with blue undertone */
  --bg-secondary: #12121a;      /* Card/panel background */
  --bg-tertiary: #1a1a2e;       /* Hover states, active rows */
  --border: #2a2a3e;            /* Subtle borders */
  --text-primary: #e0e0e0;      /* Main text */
  --text-secondary: #8888aa;    /* Muted text */
  --accent-green: #00ff88;      /* Active/connected states, primary accent */
  --accent-red: #ff3355;        /* Errors, disconnected */
  --accent-amber: #ffaa00;      /* Warnings, pending states */
  --accent-cyan: #00ccff;       /* Links, interactive elements */
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  --font-sans: 'IBM Plex Sans', sans-serif;
}
```

### Design Rules
- **Background:** Dark, near-black. No pure white anywhere.
- **Typography:** Monospace for data (addresses, prices, IDs, table content). Sans-serif only for headings/labels.
- **Borders:** 1px solid with low-opacity borders. No rounded corners larger than 4px. Sharp, utilitarian.
- **Tables:** Compact rows, no zebra striping. Highlight row on hover with `--bg-tertiary`. Column headers uppercase, small, letter-spaced.
- **Buttons:** Outlined by default, filled on hover. Primary actions use `--accent-green`. Destructive actions use `--accent-red`.
- **Status indicators:** Small filled circles (8px), pulsing animation when "active".
- **Flags:** Small (16×12px) inline with country text.
- **Scrollbars:** Thin, styled to match the dark theme.
- **Animations:** Minimal. Fade-in on mount. Subtle progress bar for connection steps.
- **No rounded cards, no shadows, no gradients.** This is raw, functional, hacker aesthetic.
- **Header bar:** App name in monospace ("SENTINEL dVPN"), wallet address truncated, balance, and a connection status dot. Minimal.

---

## Project Structure

```
sentinel-dvpn-app/
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── tailwind.config.js
├── postcss.config.js
├── src/
│   ├── main/                      # Electron main process
│   │   ├── index.ts               # App entry, BrowserWindow, IPC handlers
│   │   ├── wallet.ts              # Mnemonic encryption/decryption (safeStorage)
│   │   ├── sentinel-service.ts    # SDK client, tx signing, handshake orchestration
│   │   ├── vpn-manager.ts         # V2Ray/WireGuard connect/disconnect lifecycle
│   │   └── ipc-handlers.ts        # All ipcMain.handle() registrations
│   ├── preload/
│   │   └── index.ts               # contextBridge.exposeInMainWorld('api', { ... })
│   ├── renderer/                   # React app
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── styles/
│   │   │   └── global.css         # Tailwind directives + custom cypherpunk styles
│   │   ├── components/
│   │   │   ├── MnemonicInput.tsx
│   │   │   ├── NodeTable.tsx
│   │   │   ├── NodeFilters.tsx
│   │   │   ├── ConnectionModal.tsx
│   │   │   ├── ConnectionStatus.tsx
│   │   │   ├── WalletPanel.tsx
│   │   │   ├── QRCodeDisplay.tsx
│   │   │   └── ProgressSteps.tsx
│   │   ├── hooks/
│   │   │   ├── useNodes.ts        # Fetch + filter + sort node list
│   │   │   ├── useWallet.ts       # Wallet state, balance polling
│   │   │   └── useConnection.ts   # Connection flow state machine
│   │   └── types/
│   │       └── index.ts           # Shared types (Node, Price, ConnectionState, etc.)
│   └── shared/
│       └── ipc-channels.ts        # String constants for IPC channel names
├── resources/
│   └── icon.png
└── README.md
```

---

## IPC Contract (Preload Bridge)

Define these typed channels in `shared/ipc-channels.ts` and expose via `contextBridge`:

```typescript
// Wallet
'wallet:has-stored'      → () => Promise<boolean>
'wallet:import'          → (mnemonic: string) => Promise<{ address: string }>
'wallet:get-address'     → () => Promise<string | null>
'wallet:get-balance'     → () => Promise<{ denom: string, amount: string }[]>
'wallet:logout'          → () => Promise<void>

// Nodes
'nodes:fetch'            → () => Promise<SentNode[]>

// Connection
'connection:subscribe'   → (params: SubscribeParams) => Promise<{ sessionId: string }>
'connection:connect'     → (params: ConnectParams) => Promise<ConnectionResult>
'connection:disconnect'  → () => Promise<void>
'connection:status'      → () => Promise<ConnectionStatus>

// Events (main → renderer)
'connection:progress'    → (step: string, detail: string) => void  // via ipcRenderer.on
```

---

## Execution Plan — Phased Development

### Phase 0: Project Scaffolding
- Initialize Electron + Vite + React + TypeScript project
- Configure Tailwind CSS with the cypherpunk color palette
- Set up the project structure as specified above
- Install all dependencies: `@sentinel-official/sentinel-js-sdk`, `@cosmjs/proto-signing`, `@cosmjs/stargate`, `long`, `qrcode`, `flag-icons` (or equivalent), `@tanstack/react-virtual`
- Configure Electron security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Create the preload script with contextBridge skeleton
- **Deliverable:** App launches, shows an empty window with the dark theme applied

### Phase 1: Wallet Management
- Implement `wallet.ts` in main process (encrypt/decrypt mnemonic with `safeStorage`)
- Implement IPC handlers for wallet operations
- Build `MnemonicInput.tsx` component (full-screen dark form, BIP-39 validation)
- Build `WalletPanel.tsx` (address display, balance fetching via CosmJS)
- Wire up the login/logout flow
- **Deliverable:** User can enter mnemonic, it's securely stored, address + balance shown on subsequent launches

### Phase 2: Node Browser
- Implement node fetching from `https://api.sentnodes.com/v2/nodes` in main process
- Build `NodeTable.tsx` with virtualized rows
- Build `NodeFilters.tsx` with all filter controls
- Implement country flags
- Implement column sorting
- Add auto-refresh (60s interval)
- **Deliverable:** Full node browser with filtering, sorting, flags, responsive and fast with 5000+ nodes

### Phase 3: Subscription & Handshake
- Implement `sentinel-service.ts`: signing client creation, `nodeStartSession` tx, event parsing
- Build `ConnectionModal.tsx`: node details, GB/hours selector, cost calculator, balance check
- Build `ProgressSteps.tsx`: 5-step visual progress indicator
- Handle both GB-based and hour-based subscriptions (`TxNodeStartSession` with `gigabytes` OR `hours` + `maxPrice`)
- Parse `NodeEventCreateSession` to extract `sessionId`
- **Deliverable:** User can select a node, choose subscription type, broadcast tx, get session ID

### Phase 4: VPN Tunnel (V2Ray + WireGuard)
- Implement `vpn-manager.ts`: V2Ray and WireGuard connection lifecycle
- V2Ray flow: `new V2Ray()` → handshake → `parseConfig` → `connect()` → show inbound proxy details → `disconnect()`
- WireGuard flow: `new Wireguard()` → handshake → `parseConfig` → offer "Show QR" or "Connect"
  - QR: render config as QR code using `qrcode` library
  - Connect: requires privilege escalation (`pkexec` on Linux) — handle via Electron's `sudo-prompt` or `child_process.exec` with `pkexec`
- Build `ConnectionStatus.tsx`: live status, connected node info, session ID, proxy details, disconnect button
- Build `QRCodeDisplay.tsx`
- **Deliverable:** Full VPN connection working for both V2Ray and WireGuard nodes

### Phase 5: Polish & Hardening
- Error handling: network failures, insufficient balance, tx failures, node unreachable
- Loading states for every async operation
- Graceful disconnect on app quit (`app.on('before-quit', ...)`)
- Kill V2Ray/WG child processes on disconnect and on app exit
- Tray icon with connection status (optional but nice)
- Toast/notification system for errors and status changes
- Test with real mnemonic on Sentinel mainnet
- **Deliverable:** Production-ready app, robust error handling, clean UX

---

## Critical Implementation Notes

1. **The SDK's `handshake()` function** requires the node's remote address. When using the sentnodes REST API (not on-chain query), you get an `api` field instead of `remoteAddrs`. You will likely need to either:
   - Query the node on-chain via `client.sentinelQuery?.node.node(nodeAddress)` to get `remoteAddrs`, OR
   - Construct `https://{api_field}` and pass it to `handshake()`.
   **Test both approaches** and use whichever the SDK accepts.

2. **Hour-based subscriptions** use `hours` instead of `gigabytes` in `TxNodeStartSession`. Check the SDK's TypeScript types to confirm the exact field name — it may be `hours: Long.fromNumber(n, true)` alongside `maxPrice` from `hourlyPrices`.

3. **V2Ray `type` field mapping:** The sentnodes API returns `type: 2` for V2Ray, `type: 1` for WireGuard. The SDK may use `NodeVPNType.WIREGUARD` / `NodeVPNType.V2RAY` enums internally — map between them correctly.

4. **WireGuard requires root/admin:** On Linux, creating a WG interface requires `CAP_NET_ADMIN`. Use `pkexec` for privilege escalation. Inform the user in the UI that admin privileges are required.

5. **udvpn denomination:** Amounts on-chain are in `udvpn` (micro-DVPN). 1 DVPN = 1,000,000 udvpn. Display human-readable DVPN amounts in the UI (divide by 1e6).

6. **Gas price:** Follow the example: `GasPrice.fromString("0.2udvpn")`.

7. **Electron security is non-negotiable:** No `nodeIntegration`, no `remote` module, no loading external URLs in the main window. All SDK/crypto operations in main process only.

---

## How to Proceed

**Generate the phased plan as `PLAN.md` first.** The plan should expand each phase into granular tasks with estimated complexity, list all npm packages needed, flag any open questions or risks, and define a "done" criteria for each phase. After I review and approve the plan, I'll tell you which phase to start building.

**When building each phase:**
- Write complete, working code — no placeholders, no TODOs, no "implement this later".
- Include proper TypeScript types throughout.
- Handle errors explicitly with user-facing messages.
- Test that the code compiles and runs at each phase boundary.
- Commit-ready quality: lint-clean, no console.logs in production paths.
