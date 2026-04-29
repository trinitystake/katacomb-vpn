export interface SentNode {
  address: string
  moniker: string
  version: string
  type: 1 | 2 // 1=WireGuard, 2=V2Ray
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
  type: 'all' | 'wireguard' | 'v2ray'
  activeOnly: boolean
  healthyOnly: boolean
  residentialOnly: boolean
  whitelistedOnly: boolean
  hideDuplicates: boolean
  bookmarkedOnly: boolean
  search: string
}

export interface SubscribeParams {
  nodeAddress: string
  nodeMoniker: string
  nodeCountry: string
  nodeType: 1 | 2
  apiField: string
  type: 'gigabytes' | 'hours'
  amount: number
  denom: string
  quoteValue: string
}

export interface ReconnectParams {
  sessionId: string
}

export interface ConnectParams {
  protocol: 'wireguard' | 'v2ray'
  configString?: string
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

export type ConnectionState =
  | 'idle'
  | 'subscribing'
  | 'handshaking'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'reconnecting'
  | 'error'

export interface ConnectionStatus {
  state: ConnectionState
  nodeAddress?: string
  nodeMoniker?: string
  nodeCountry?: string
  nodeType?: 1 | 2
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
}

export interface AppSettings {
  rpcEndpoint: string
  activeWalletId: string | null
  killSwitch: boolean
  dnsResolver: string
  autoReconnect: boolean
  bookmarkedNodes: string[]
  splitTunnelRoutes: string[]
  preferHourlyWhenCheaper: boolean
  pollStatusSec: number
  pollIpSec: number
  pollBalanceSec: number
  pollAllocationSec: number
  planDiscoveryMaxId: number
}

export interface PlanInfo {
  id: string
  provAddress: string
  bytes: string
  durationSeconds: number | null
  prices: { denom: string; baseValue: string; quoteValue: string }[]
  private: boolean
  status: number
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
  walletImport: (mnemonic: string) => Promise<{ address: string }>
  walletGetAddress: () => Promise<string | null>
  walletGetBalance: () => Promise<{ denom: string; amount: string }[]>
  walletLogout: () => Promise<void>
  walletSessions: () => Promise<SessionInfo[]>
  walletEndSession: (sessionId: string) => Promise<void>
  walletList: () => Promise<WalletEntry[]>
  walletSwitch: (walletId: string) => Promise<{ address: string | null }>
  walletDelete: (walletId: string) => Promise<void>
  walletRename: (walletId: string, newName: string) => Promise<void>

  settingsGet: () => Promise<AppSettings>
  settingsSet: (settings: Partial<AppSettings>) => Promise<AppSettings>

  nodesFetch: () => Promise<SentNode[]>
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
    nodeType: 1 | 2
    apiField: string
  }) => Promise<{ sessionId: string; subscriptionId: string; protocol: string; configString: string }>
  planNodes: (planId: string) => Promise<string[]>
  onPlanDiscoverProgress: (callback: (progress: DiscoverProgress) => void) => () => void

  providerGet: (address: string) => Promise<ProviderInfo | null>
  providerList: () => Promise<ProviderInfo[]>

  trafficStats: () => Promise<TrafficStats>

  bookmarkToggle: (nodeAddress: string) => Promise<string[]>
  bookmarkList: () => Promise<string[]>

  rpcCheck: (endpoint: string) => Promise<{ latencyMs: number; chainId: string }>

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
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
