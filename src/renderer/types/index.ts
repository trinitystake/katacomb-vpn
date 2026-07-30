import type { V2RayCategory } from '../utils/v2ray-connection'
import type { ProtocolType } from '../utils/protocols'

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
  errorMessage: string
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
  error?: string
  reconnectAttempt?: number
  reconnectMaxAttempts?: number
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
}

export interface AppSettings {
  rpcEndpoint: string
  activeWalletId: string | null
  killSwitch: boolean
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

export interface PublicRpc {
  provider: string
  address: string
  status: number
  height: number
  location: string
  isLoadbalance: number
  availability: number
  errorReason: string | null
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
  walletGetBalance: () => Promise<{ denom: string; amount: string }[]>
  walletLogout: () => Promise<void>
  walletSessions: () => Promise<SessionInfo[]>
  walletEndSession: (sessionId: string) => Promise<void>
  walletList: () => Promise<WalletEntry[]>
  walletSwitch: (walletId: string) => Promise<{ address: string | null }>
  walletDelete: (walletId: string) => Promise<void>
  walletRename: (walletId: string, newName: string) => Promise<void>
  walletDeriveSubaccount: (params: { sourceWalletId: string; accountIndex: number; name: string }) => Promise<{ address: string }>

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
  subscriptionUpdatePolicy: (subscriptionId: string, policy: number) => Promise<void>
  onPlanDiscoverProgress: (callback: (progress: DiscoverProgress) => void) => () => void

  providerGet: (address: string) => Promise<ProviderInfo | null>
  providerList: () => Promise<ProviderInfo[]>

  trafficStats: () => Promise<TrafficStats>

  bookmarkToggle: (nodeAddress: string) => Promise<string[]>
  bookmarkList: () => Promise<string[]>

  rpcCheck: (endpoint: string) => Promise<{ latencyMs: number; chainId: string }>
  rpcList: () => Promise<PublicRpc[]>

  binaryCheck: () => Promise<BinaryStatus>

  nodeTestProbe: (params: { nodeAddress: string; remoteUrl: string }) => Promise<NodeProbeResult>
  nodeTestBatch: (nodes: Array<{ nodeAddress: string; remoteUrl: string }>) => Promise<void>
  nodeTestSpeed: () => Promise<SpeedTestResult>
  nodeTestCancel: () => Promise<void>
  nodeTestResults: () => Promise<Record<string, NodeProbeResult>>
  onNodeTestProgress: (callback: (progress: BatchProgress) => void) => () => void

  connectionSubscribe: (params: SubscribeParams) => Promise<SubscribeResult>
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
