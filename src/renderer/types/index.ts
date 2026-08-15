import type { V2RayCategory } from '../utils/v2ray-connection'
import type { ProtocolType } from '../utils/protocols'
import type { RpcCandidate, RpcHealth } from '../../shared/rpc-health'

export interface SentNode {
  address: string
  moniker: string
  version: string
  // Numeric protocol tag from the node-list API. 0=unknown, 1=WireGuard,
  // 2=V2Ray, 3=OpenVPN, 4=XRAY, 5=AmneziaWG, 6=Hysteria2 (see utils/protocols.ts).
  // All of 1-6 are connectable (0=unknown is not).
  type: number
  // V2Ray proxy/transport/security advertised by the node list API. null for
  // WireGuard and for V2Ray nodes that don't advertise it. Operator-supplied —
  // untrusted; the real check happens at handshake (see config-guard.ts).
  connection: { proxy: string; transport: string; security: string } | null
  api: string
  asn: string
  country: string
  city: string
  isResidential: boolean
  isActive: boolean
  isHealthy: boolean
  isDuplicate: boolean
  isWhitelisted: boolean
  gigabytePrices: NodePrice[]
  hourlyPrices: NodePrice[]
  leases: number
  sessions: number
  peers: number
  // Why the node failed the aggregator's health probe ('VPN connect failed',
  // 'Handshake failed', …). Absent on healthy nodes — see utils/node-status.ts.
  errorMessage: string | null
  fetchedAt: string
}

export interface NodePrice {
  denom: string
  value: string
}

export interface NodeFilter {
  country: string
  city: string
  type: 'all' | ProtocolType
  activeOnly: boolean
  healthyOnly: boolean
  residentialOnly: boolean
  whitelistedOnly: boolean
  hideDuplicates: boolean
  bookmarkedOnly: boolean
  // Per-connection-category visibility for V2Ray nodes (node-list sub-filter).
  v2rayConnection: Record<V2RayCategory, boolean>
  search: string
}

export interface SubscribeParams {
  nodeAddress: string
  nodeMoniker: string
  nodeCountry: string
  nodeType: number
  apiField: string
  type: 'gigabytes' | 'hours'
  amount: number
  denom: string
  quoteValue: string
}

export interface ReconnectParams {
  sessionId: string
}

/** One hop of a multihop chain. `nodeType` must be 2 (V2Ray) or 4 (XRAY). */
export interface ChainHopParams {
  nodeAddress: string
  nodeMoniker: string
  nodeCountry: string
  nodeType: number
  apiField: string
  quoteValue: string
}

/**
 * Buy a two-hop chain: entry -> exit. One duration/size applies to both hops (a
 * chain only lives as long as its shorter half), and the cost is the sum. Main
 * cancels BOTH sessions if any part of the purchase or handshake fails.
 */
export interface SubscribeChainParams {
  entry: ChainHopParams
  exit: ChainHopParams
  type: 'gigabytes' | 'hours'
  amount: number
  denom: string
  /**
   * Pay for the EXIT hop from this wallet instead of the active one. Two accounts
   * mean neither node can find the other half of the chain by reading its session's
   * `accAddress` and querying SessionsForAccount. The wallet must already exist and
   * already hold funds — the app never creates or funds one, because a transfer
   * between them is itself a public on-chain link.
   */
  exitWalletId?: string
}

export type TunnelProtocol = 'wireguard' | 'amneziawg' | 'v2ray' | 'xray' | 'hysteria2' | 'openvpn'

/** A subscription as listed by the Subscriptions manager. */
export interface SubscriptionSummary {
  id: string
  /** '0' = a node (per-GB/hour) subscription; otherwise the plan it belongs to. */
  planId: string
  status: number
  /** sentinel.types.v1.RenewalPricePolicy — 0 = never renew, 7 = always. */
  renewalPricePolicy: number
  startAt: string | null
  inactiveAt: string | null
}

export interface ConnectParams {
  protocol: TunnelProtocol
  /**
   * 'tunnel' (default) routes the whole device. 'proxy' is v2ray/xray/hysteria2
   * only: just their local SOCKS5 listener, no TUN and no root.
   */
  mode?: 'tunnel' | 'proxy'
  configString?: string
  /**
   * WireGuard/AmneziaWG only: bring the tunnel up with its `DNS =` lines
   * stripped, for hosts without resolvconf. Explicit user consent only — DNS
   * queries then use the system resolver, outside the tunnel.
   */
  dnsFallback?: boolean
}

export interface SubscribeResult {
  sessionId: string
  protocol: string
}

/** `sessionId` is the ENTRY hop — the primary session for status and reconnect. */
export interface SubscribeChainResult {
  sessionId: string
  exitSessionId: string
  protocol: string
  configString: string
}

export interface ReconnectResult {
  sessionId: string
  protocol: string
  configString: string
}

export interface SessionInfo {
  id: string
  nodeAddress: string
  status: string
  downloadBytes: string
  uploadBytes: string
  maxBytes: string
  inactiveAt: string | null
  startAt: string | null
  durationSeconds: number | null
  maxDurationSeconds: number | null
  subscriptionId: string | null
  priceDenom: string | null
  priceValue: string | null
  nodeMoniker: string
  nodeCountry: string
  /**
   * Set on both halves of a multihop chain: the other hop's session id, and which
   * end this one is. They are two independent on-chain sessions, so without these
   * the tab shows two unrelated rows and offers to end one — which tears the tunnel
   * down and leaves the other paid for. Absent on an ordinary single-hop session.
   */
  chainPeerSessionId?: string
  chainRole?: 'entry' | 'exit'
}

/**
 * How a node graded for each end of a chain, from the inbounds it publishes at its
 * root path. `reachable: false` means we could not ask (unreachable, or a pre-9.0.0
 * node that publishes no listing) — NOT that the node is unusable.
 */
export interface ChainEligibility {
  nodeAddress: string
  checkedAt: number
  reachable: boolean
  transports: string[]
  /** Dialable directly with TLS or Reality — usable as a chain ENTRY. */
  entry: boolean
  /** Serves plain TCP with TLS or Reality — usable as a chain EXIT. */
  exit: boolean
  /** How the entry-capable inbound would be wrapped, or null if none qualifies. */
  entrySecurity: 'reality' | 'tls' | null
  /** How the exit-capable inbound would be wrapped, or null if none qualifies. */
  exitSecurity: 'reality' | 'tls' | null
  error?: string
}

export type ConnectionState = 'idle' | 'connected' | 'reconnecting'

export interface ConnectionStatus {
  state: ConnectionState
  nodeAddress?: string
  nodeMoniker?: string
  nodeCountry?: string
  nodeType?: number
  v2raySummary?: string
  killSwitchFailed?: boolean
  killSwitchTeardownFailed?: boolean
  /** Connected in local-proxy mode: SOCKS5 only, system routing untouched. */
  proxyMode?: boolean
  /** Where to point apps in proxy mode, e.g. '127.0.0.1:1080'. */
  socksAddr?: string
  sessionId?: string
  /**
   * Present only when a two-hop (multihop) chain is up. `nodeAddress`/`sessionId`
   * above are the ENTRY hop — the node this host dials directly; this is the exit,
   * whose location the traffic appears to come from. Both sessions are paid, both
   * quotas are watched, and either running out ends the chain.
   */
  chainExit?: {
    sessionId?: string
    address: string
    moniker: string
    country: string
    type: number
  }
  /**
   * Epoch ms when the current tunnel came up. The Sessions card adds the elapsed
   * time since to the chain's metered `duration` for a live time gauge — the chain
   * meters from node proofs, so wall-clock since the session's `startAt` is not a
   * usage measure.
   */
  connectedAt?: number
  error?: string
  reconnectAttempt?: number
  reconnectMaxAttempts?: number
  /**
   * Main tore the tunnel down on its own. Either the session ran out of the time or
   * data it was paid for ('time'/'data'), or the tunnel stopped carrying traffic
   * ('stalled') — the latter is NOT an expiry: the session is normally still live on
   * chain and reconnecting renews the handshake. `trafficBlocked` means the kill
   * switch was left armed on purpose (the user's preference standing in for "no
   * tunnel, no traffic"), so the internet is down until they restore it. Cleared by
   * the next connect or disconnect.
   */
  expired?: {
    sessionId: string
    nodeMoniker: string
    reason: 'time' | 'data' | 'stalled'
    trafficBlocked: boolean
    /**
     * MULTIHOP: which end of the chain ran out, so the banner can name it. `sessionId`
     * and `nodeMoniker` are that hop's, not necessarily the entry's. Absent for an
     * ordinary single-hop session.
     */
    chainRole?: 'entry' | 'exit'
  }
}

export interface WalletState {
  loaded: boolean
  address: string | null
  balance: string | null
}

export interface WalletEntry {
  id: string
  name: string
  address: string
  accountIndex?: number
  addressIndex?: number
  /** Reveals the Provider tab for this wallet, before it has one on chain. */
  providerMode?: boolean
}

/** One candidate derivation path in the Derive Subaccount picker. */
export interface DerivationPreview {
  addressIndex: number
  path: string
  address: string
  /** Name of the stored wallet already holding this address, else null. */
  existingWalletName: string | null
}

/** What the wallet store holds on disk, whether or not one is currently active. */
export interface WalletStoreStatus {
  wallets: (WalletEntry & {
    /**
     * False when the seed can't be decrypted — e.g. saved under the app's
     * previous name, since safeStorage keys its keyring entry by app name.
     * Such a wallet must be re-imported from its phrase, not just selected.
     */
    unlockable: boolean
  })[]
  activeWalletId: string | null
  /**
   * Set when a seed outlived its last wallet (deleted with "keep seed"). New
   * wallets can be derived from it without retyping the phrase. Non-null only
   * while `wallets` is empty.
   */
  retainedSeedId: string | null
}

export interface AppSettings {
  rpcEndpoint: string
  activeWalletId: string | null
  killSwitch: boolean
  lanSharing: boolean
  dnsResolver: string
  autoReconnect: boolean
  bookmarkedNodes: string[]
  splitTunnelRoutes: string[]
}

export interface PlanInfo {
  id: string
  provAddress: string
  bytes: string
  durationSeconds: number | null
  prices: { denom: string; baseValue: string; quoteValue: string }[]
  private: boolean
  status: number
  isTest: boolean
}

export interface ProviderInfo {
  address: string
  name: string
  identity: string
  website: string
  description: string
}

export interface PlanAllocation {
  subscriptionId: string
  planId: string
  planProvAddress: string
  planBytes: string
  planDurationSeconds: number | null
  startAt: string | null
  inactiveAt: string | null
  status: number
}

export interface DiscoverProgress {
  done: number
  total: number
  phase: 'connecting' | 'fetching' | 'done'
}

// --- Provider console ---

export interface ProviderDetailsInput {
  name: string
  identity: string
  website: string
  description: string
}

/** This wallet's own provider record. `address` is always set — it is derived locally. */
export interface MyProvider extends ProviderDetailsInput {
  address: string
  registered: boolean
  /** sentinel.types.v1.Status: 1 active, 3 inactive, 0 when not registered. */
  status: number
}

export interface MyPlan {
  id: string
  bytes: string
  durationSeconds: number | null
  prices: { denom: string; baseValue: string; quoteValue: string }[]
  private: boolean
  status: number
}

/** What a plan is currently worth to its provider: nodes serving it, subscriptions sold. */
export interface PlanStats {
  nodes: number
  subscriptions: number
  active: number
  /** The active count is a floor — the plan has more subscriptions than were scanned. */
  truncated: boolean
}

/**
 * The provider's money picture, all figures udvpn integer strings computed in main.
 *
 * There is deliberately no profit line: the chain deletes leases once they end, so
 * lifetime spend can't be known, and pairing complete revenue with partial costs
 * would overstate how well the business is doing.
 */
export interface ProviderEconomics {
  burnHourlyUdvpn: string
  burnDailyUdvpn: string
  activeLeases: number
  /** Escrowed but unspent — refunded if every lease ended now. */
  committedUdvpn: string
  /** Cumulative, net of the staking share, and a floor: renewals aren't counted. */
  estimatedRevenueUdvpn: string
  subscriptions: number
  /** LegacyDec (10^18-scaled) cut the hub keeps from plan sales. Drives break-even. */
  subscriptionStakingShare: string
  /** LegacyDec (10^18-scaled) community-pool cut of lease payments. '' if absent. */
  leaseStakingShare: string
}

export interface TokenPrice {
  /** USD for one P2P. */
  usd: number
  fetchedAt: number
}

/** A lease bought from a node operator — the prerequisite for linking that node to a plan. */
export interface LeaseSummary {
  id: string
  provAddress: string
  nodeAddress: string
  hourlyPrice: string
  hours: number
  maxHours: number
  renewalPricePolicy: number
  startAt: string | null
}

export interface LeaseQuote {
  hourlyPrice: string
  totalUdvpn: string
  nodeStatus: number
  minHours: number
  maxHours: number
}

export interface TrafficStats {
  rxBytes: number
  txBytes: number
  rxSpeed: number
  txSpeed: number
}

export interface IpInfo {
  ip: string
  country: string
  city: string
  asn: string
  org: string
}

/** One endpoint probed by `rpcProbeAll`, with the aggregator's metadata folded in. */
export interface RpcCandidateInfo extends RpcCandidate {
  provider: string
  location: string
  availability: number | null
}

export interface BinaryStatus {
  wireguard: boolean
  v2ray: boolean
  tun2socks: boolean
}

export interface NodeProbeResult {
  nodeAddress: string
  timestamp: number
  reachable: boolean
  latencyMs: number | null
  error?: string
}

export interface SpeedTestResult {
  downloadMbps: number
  googleLatencyMs: number | null
  googleReachable: boolean
  error?: string
}

export interface BatchProgress {
  done: number
  total: number
  result: NodeProbeResult
}

export interface ElectronAPI {
  walletHasStored: () => Promise<boolean>
  walletGenerate: (wordCount: 12 | 24) => Promise<string>
  walletImport: (mnemonic: string, name?: string) => Promise<{ address: string }>
  walletGetAddress: () => Promise<string | null>
  /** null when the balance is unknown (RPC unreachable and nothing cached yet). */
  walletGetBalance: () => Promise<{ denom: string; amount: string }[] | null>
  walletLogout: () => Promise<void>
  walletSessions: () => Promise<SessionInfo[]>
  walletEndSession: (sessionId: string) => Promise<void>
  walletList: () => Promise<WalletEntry[]>
  /**
   * Is the given wallet visibly funded from the active one? `checked: false` means
   * the chain could not answer (pruned RPC, unreachable) — never treat that as clean.
   */
  walletLinkCheck: (walletId: string) => Promise<{ checked: boolean; linked: boolean }>
  walletSwitch: (walletId: string) => Promise<{ address: string | null }>
  /** `keepSeed` applies only to the last wallet — see WalletStoreStatus.retainedSeedId. */
  walletDelete: (walletId: string, keepSeed?: boolean) => Promise<void>
  /** `keepSeed` retains the active wallet's encrypted seed — see WalletStoreStatus.retainedSeedId. */
  walletDeleteAll: (keepSeed?: boolean) => Promise<void>
  walletStoreStatus: () => Promise<WalletStoreStatus>
  walletRename: (walletId: string, newName: string) => Promise<void>
  walletDeriveSubaccount: (params: { sourceWalletId: string; accountIndex: number; addressIndex: number; name: string }) => Promise<{ address: string }>
  walletDerivePreview: (params: { sourceWalletId: string; accountIndex: number; startIndex: number; count: number }) => Promise<DerivationPreview[]>
  /** The wallet's seed phrase, for the user to write down. Handle as secret. */
  walletRevealMnemonic: (walletId: string) => Promise<{ mnemonic: string }>

  settingsGet: () => Promise<AppSettings>
  settingsSet: (settings: Partial<AppSettings>) => Promise<AppSettings>

  nodesFetch: () => Promise<SentNode[]>
  nodesGetCached: () => Promise<{ nodes: SentNode[]; fetchedAt: number } | null>
  onNodesUpdate: (callback: (nodes: SentNode[]) => void) => () => void
  networkGetIp: (includeGeo?: boolean) => Promise<IpInfo>

  planDiscover: (maxId: number) => Promise<PlanInfo[]>
  planListCached: () => Promise<{ plans: PlanInfo[]; fetchedAt: number | null }>
  planAllocations: () => Promise<PlanAllocation[]>
  planSubscribe: (params: {
    planId: string
    denom: string
    nodeAddress: string
    nodeMoniker: string
    nodeCountry: string
    nodeType: number
    apiField: string
    renewalPolicy?: number
  }) => Promise<{ sessionId: string; subscriptionId: string; protocol: string; configString: string }>
  planStartSessionFromSub: (params: {
    subscriptionId: string
    nodeAddress: string
    nodeMoniker: string
    nodeCountry: string
    nodeType: number
    apiField: string
  }) => Promise<{ sessionId: string; subscriptionId: string; protocol: string; configString: string }>
  planNodes: (planId: string) => Promise<string[]>
  planListForNode: (nodeAddress: string) => Promise<PlanInfo[]>
  subscriptionList: () => Promise<SubscriptionSummary[]>
  subscriptionCancel: (subscriptionId: string) => Promise<void>
  subscriptionRenew: (subscriptionId: string, planId: string, denom: string) => Promise<void>
  subscriptionUpdatePolicy: (subscriptionId: string, policy: number) => Promise<void>
  onPlanDiscoverProgress: (callback: (progress: DiscoverProgress) => void) => () => void

  providerGet: (address: string) => Promise<ProviderInfo | null>
  providerList: () => Promise<ProviderInfo[]>

  /**
   * Provider console. Every one of these needs the chain live: main returns null/[]
   * rather than stale data while the VPN tunnel is up, and the writes throw.
   */
  providerMe: () => Promise<MyProvider | null>
  /** Sets provider mode on the ACTIVE wallet; read it back off the wallet entry. */
  providerModeSet: (enabled: boolean) => Promise<void>
  providerDeposit: () => Promise<{ denom: string; amount: string } | null>
  providerRegister: (params: ProviderDetailsInput) => Promise<void>
  providerUpdateDetails: (params: ProviderDetailsInput) => Promise<void>
  providerSetStatus: (active: boolean) => Promise<void>
  providerPlans: () => Promise<MyPlan[]>
  providerPlanCreate: (params: {
    gigabytes: number
    days: number
    priceUdvpn: number
    private: boolean
  }) => Promise<void>
  providerPlanSetStatus: (planId: string, active: boolean) => Promise<void>
  providerPlanLink: (planId: string, nodeAddress: string) => Promise<void>
  providerPlanUnlink: (planId: string, nodeAddress: string) => Promise<void>
  /** Keyed by plan id; a plan the chain couldn't answer for is simply absent. */
  providerPlanStats: (planIds: string[]) => Promise<Record<string, PlanStats>>
  /** Null while the VPN is up — chain reads don't survive the tunnel. */
  providerEconomics: () => Promise<ProviderEconomics | null>

  /** USD per P2P, for display next to prices. Null when unavailable. */
  priceToken: () => Promise<TokenPrice | null>

  leaseList: () => Promise<LeaseSummary[]>
  leaseParams: () => Promise<{ minHours: number; maxHours: number } | null>
  leaseQuote: (nodeAddress: string, hours: number) => Promise<LeaseQuote>
  leaseStart: (params: { nodeAddress: string; hours: number; renewalPolicy: number }) => Promise<void>
  leaseEnd: (leaseId: string) => Promise<void>

  trafficStats: () => Promise<TrafficStats>

  bookmarkToggle: (nodeAddress: string) => Promise<string[]>
  bookmarkList: () => Promise<string[]>

  /** Live health of the endpoint in use — also pushed via onRpcHealthUpdate. */
  rpcHealthGet: () => Promise<RpcHealth>
  rpcProbeAll: () => Promise<RpcCandidateInfo[]>
  onRpcHealthUpdate: (callback: (health: RpcHealth) => void) => () => void

  binaryCheck: () => Promise<BinaryStatus>

  nodeTestProbe: (params: { nodeAddress: string; remoteUrl: string }) => Promise<NodeProbeResult>
  nodeTestBatch: (nodes: Array<{ nodeAddress: string; remoteUrl: string }>) => Promise<void>
  nodeTestSpeed: () => Promise<SpeedTestResult>
  nodeTestCancel: () => Promise<void>
  nodeTestResults: () => Promise<Record<string, NodeProbeResult>>
  /** Max 60 nodes per call — the picker probes in chunks so it can show progress. */
  nodeChainEligibility: (
    nodes: Array<{ nodeAddress: string; remoteUrl: string; nodeType: number }>,
  ) => Promise<ChainEligibility[]>
  onNodeTestProgress: (callback: (progress: BatchProgress) => void) => () => void

  connectionSubscribe: (params: SubscribeParams) => Promise<SubscribeResult>
  connectionSubscribeChain: (params: SubscribeChainParams) => Promise<SubscribeChainResult>
  connectionReconnect: (params: ReconnectParams) => Promise<ReconnectResult>
  connectionCheckVpn: () => Promise<{ type: string; name: string; iface?: string }[]>
  connectionConnect: (params: ConnectParams) => Promise<{ protocol: string }>
  connectionDisconnect: () => Promise<void>
  connectionStatus: () => Promise<ConnectionStatus>

  onConnectionProgress: (callback: (step: string, detail: string) => void) => () => void
  onConnectionStateChange: (callback: (state: string) => void) => () => void
  onConnectionReconnecting: (callback: (attempt: number, maxAttempts: number) => void) => () => void
  onTrayConnect: (callback: () => void) => () => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
