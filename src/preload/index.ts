import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'

contextBridge.exposeInMainWorld('api', {
  walletHasStored: () => ipcRenderer.invoke(IPC.WALLET_HAS_STORED),
  walletGenerate: (wordCount: 12 | 24) => ipcRenderer.invoke(IPC.WALLET_GENERATE, wordCount),
  walletImport: (mnemonic: string, name?: string) => ipcRenderer.invoke(IPC.WALLET_IMPORT, mnemonic, name),
  walletGetAddress: () => ipcRenderer.invoke(IPC.WALLET_GET_ADDRESS),
  walletGetBalance: () => ipcRenderer.invoke(IPC.WALLET_GET_BALANCE),
  walletLogout: () => ipcRenderer.invoke(IPC.WALLET_LOGOUT),
  walletSessions: () => ipcRenderer.invoke(IPC.WALLET_SESSIONS),
  walletEndSession: (sessionId: string) => ipcRenderer.invoke(IPC.WALLET_END_SESSION, sessionId),
  walletList: () => ipcRenderer.invoke(IPC.WALLET_LIST),
  walletSwitch: (walletId: string) => ipcRenderer.invoke(IPC.WALLET_SWITCH, walletId),
  walletDelete: (walletId: string, keepSeed?: boolean) => ipcRenderer.invoke(IPC.WALLET_DELETE, walletId, keepSeed),
  walletDeleteAll: (keepSeed?: boolean) => ipcRenderer.invoke(IPC.WALLET_DELETE_ALL, keepSeed),
  walletStoreStatus: () => ipcRenderer.invoke(IPC.WALLET_STORE_STATUS),
  walletRename: (walletId: string, newName: string) => ipcRenderer.invoke(IPC.WALLET_RENAME, walletId, newName),
  walletDeriveSubaccount: (params: { sourceWalletId: string; accountIndex: number; addressIndex: number; name: string }) =>
    ipcRenderer.invoke(IPC.WALLET_DERIVE_SUBACCOUNT, params),
  walletDerivePreview: (params: { sourceWalletId: string; accountIndex: number; startIndex: number; count: number }) =>
    ipcRenderer.invoke(IPC.WALLET_DERIVE_PREVIEW, params),
  walletRevealMnemonic: (walletId: string) => ipcRenderer.invoke(IPC.WALLET_REVEAL_MNEMONIC, walletId),

  settingsGet: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  settingsSet: (settings: Record<string, unknown>) => ipcRenderer.invoke(IPC.SETTINGS_SET, settings),

  nodesFetch: () => ipcRenderer.invoke(IPC.NODES_FETCH),
  nodesGetCached: () => ipcRenderer.invoke(IPC.NODES_GET_CACHED),
  onNodesUpdate: (callback: (nodes: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, nodes: unknown[]) => {
      callback(nodes)
    }
    ipcRenderer.on(IPC.NODES_UPDATE, handler)
    return () => {
      ipcRenderer.removeListener(IPC.NODES_UPDATE, handler)
    }
  },
  onSessionsChanged: (callback: () => void) => {
    const handler = (): void => { callback() }
    ipcRenderer.on(IPC.SESSIONS_CHANGED, handler)
    return () => {
      ipcRenderer.removeListener(IPC.SESSIONS_CHANGED, handler)
    }
  },
  networkGetIp: (includeGeo?: boolean) => ipcRenderer.invoke(IPC.NETWORK_GET_IP, includeGeo),

  trafficStats: () => ipcRenderer.invoke(IPC.TRAFFIC_STATS),

  bookmarkToggle: (nodeAddress: string) => ipcRenderer.invoke(IPC.BOOKMARK_TOGGLE, nodeAddress),
  bookmarkList: () => ipcRenderer.invoke(IPC.BOOKMARK_LIST),

  rpcHealthGet: () => ipcRenderer.invoke(IPC.RPC_HEALTH_GET),
  rpcProbeAll: () => ipcRenderer.invoke(IPC.RPC_PROBE_ALL),
  rpcAutoSelect: () => ipcRenderer.invoke(IPC.RPC_AUTO_SELECT),
  onRpcHealthUpdate: (callback: (health: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, health: unknown) => {
      callback(health)
    }
    ipcRenderer.on(IPC.RPC_HEALTH_UPDATE, handler)
    return () => {
      ipcRenderer.removeListener(IPC.RPC_HEALTH_UPDATE, handler)
    }
  },

  binaryCheck: () => ipcRenderer.invoke(IPC.BINARY_CHECK),

  nodeTestProbe: (params: { nodeAddress: string; remoteUrl: string }) =>
    ipcRenderer.invoke(IPC.NODE_TEST_PROBE, params),
  nodeTestBatch: (nodes: Array<{ nodeAddress: string; remoteUrl: string }>) =>
    ipcRenderer.invoke(IPC.NODE_TEST_BATCH, nodes),
  nodeTestSpeed: () => ipcRenderer.invoke(IPC.NODE_TEST_SPEED),
  nodeTestCancel: () => ipcRenderer.invoke(IPC.NODE_TEST_CANCEL),
  nodeTestResults: () => ipcRenderer.invoke(IPC.NODE_TEST_RESULTS),
  nodeChainEligibility: (nodes: Array<{ nodeAddress: string; remoteUrl: string; nodeType: number }>) =>
    ipcRenderer.invoke(IPC.NODE_CHAIN_ELIGIBILITY, nodes),
  walletLinkCheck: (walletId: string) => ipcRenderer.invoke(IPC.WALLET_LINK_CHECK, walletId),

  onNodeTestProgress: (callback: (progress: { done: number; total: number; result: unknown }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { done: number; total: number; result: unknown }) => {
      callback(progress)
    }
    ipcRenderer.on(IPC.NODE_TEST_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC.NODE_TEST_PROGRESS, handler)
    }
  },

  connectionSubscribe: (params: unknown) => ipcRenderer.invoke(IPC.CONNECTION_SUBSCRIBE, params),
  connectionSubscribeChain: (params: unknown) => ipcRenderer.invoke(IPC.CONNECTION_SUBSCRIBE_CHAIN, params),
  connectionReconnect: (params: unknown) => ipcRenderer.invoke(IPC.CONNECTION_RECONNECT, params),
  connectionCheckVpn: () => ipcRenderer.invoke(IPC.CONNECTION_CHECK_VPN),
  connectionConnect: (params: unknown) => ipcRenderer.invoke(IPC.CONNECTION_CONNECT, params),
  connectionDisconnect: () => ipcRenderer.invoke(IPC.CONNECTION_DISCONNECT),
  connectionStatus: () => ipcRenderer.invoke(IPC.CONNECTION_STATUS),

  onConnectionProgress: (callback: (step: string, detail: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, step: string, detail: string) => {
      callback(step, detail)
    }
    ipcRenderer.on(IPC.CONNECTION_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC.CONNECTION_PROGRESS, handler)
    }
  },

  onConnectionStateChange: (callback: (state: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: string) => {
      callback(state)
    }
    ipcRenderer.on(IPC.CONNECTION_STATE_CHANGE, handler)
    return () => {
      ipcRenderer.removeListener(IPC.CONNECTION_STATE_CHANGE, handler)
    }
  },

  onConnectionReconnecting: (callback: (attempt: number, maxAttempts: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, attempt: number, maxAttempts: number) => {
      callback(attempt, maxAttempts)
    }
    ipcRenderer.on(IPC.CONNECTION_RECONNECTING, handler)
    return () => {
      ipcRenderer.removeListener(IPC.CONNECTION_RECONNECTING, handler)
    }
  },

  // Tray "Connect" → reconnect to the most recent session (renderer drives it
  // so it reuses the same reconnect flow + error handling as the Session tab).
  onTrayConnect: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.CONNECTION_TRAY_CONNECT, handler)
    return () => {
      ipcRenderer.removeListener(IPC.CONNECTION_TRAY_CONNECT, handler)
    }
  },

  planDiscover: (maxId: number) => ipcRenderer.invoke(IPC.PLAN_DISCOVER, maxId),
  planOverview: () => ipcRenderer.invoke(IPC.PLAN_OVERVIEW),
  planSubscribe: (params: unknown) => ipcRenderer.invoke(IPC.PLAN_SUBSCRIBE, params),
  planStartSessionFromSub: (params: unknown) => ipcRenderer.invoke(IPC.PLAN_START_SESSION_FROM_SUB, params),
  planSmartConnect: (params: unknown) => ipcRenderer.invoke(IPC.PLAN_SMART_CONNECT, params),
  planNodes: (planId: string) => ipcRenderer.invoke(IPC.PLAN_NODES, { planId }),
  planListForNode: (nodeAddress: string) => ipcRenderer.invoke(IPC.PLAN_LIST_FOR_NODE, { nodeAddress }),
  subscriptionCancel: (subscriptionId: string) => ipcRenderer.invoke(IPC.SUBSCRIPTION_CANCEL, { subscriptionId }),
  subscriptionRenew: (subscriptionId: string, planId: string, denom: string) =>
    ipcRenderer.invoke(IPC.SUBSCRIPTION_RENEW, { subscriptionId, planId, denom }),
  subscriptionUpdatePolicy: (subscriptionId: string, policy: number) =>
    ipcRenderer.invoke(IPC.SUBSCRIPTION_UPDATE_POLICY, { subscriptionId, policy }),

  providerGet: (address: string) => ipcRenderer.invoke(IPC.PROVIDER_GET, { address }),
  providerList: () => ipcRenderer.invoke(IPC.PROVIDER_LIST),

  // Provider console
  providerMe: () => ipcRenderer.invoke(IPC.PROVIDER_ME),
  providerModeSet: (enabled: boolean) => ipcRenderer.invoke(IPC.PROVIDER_MODE_SET, enabled),
  providerDeposit: () => ipcRenderer.invoke(IPC.PROVIDER_DEPOSIT),
  providerRegister: (params: unknown) => ipcRenderer.invoke(IPC.PROVIDER_REGISTER, params),
  providerUpdateDetails: (params: unknown) => ipcRenderer.invoke(IPC.PROVIDER_UPDATE_DETAILS, params),
  providerSetStatus: (active: boolean) => ipcRenderer.invoke(IPC.PROVIDER_SET_STATUS, { active }),
  providerPlans: () => ipcRenderer.invoke(IPC.PROVIDER_PLANS),
  providerPlanCreate: (params: unknown) => ipcRenderer.invoke(IPC.PROVIDER_PLAN_CREATE, params),
  providerPlanSetStatus: (planId: string, active: boolean) =>
    ipcRenderer.invoke(IPC.PROVIDER_PLAN_SET_STATUS, { planId, active }),
  providerPlanLink: (planId: string, nodeAddress: string) =>
    ipcRenderer.invoke(IPC.PROVIDER_PLAN_LINK, { planId, nodeAddress }),
  providerPlanUnlink: (planId: string, nodeAddress: string) =>
    ipcRenderer.invoke(IPC.PROVIDER_PLAN_UNLINK, { planId, nodeAddress }),
  providerPlanStats: (planIds: string[]) => ipcRenderer.invoke(IPC.PROVIDER_PLAN_STATS, { planIds }),
  providerEconomics: () => ipcRenderer.invoke(IPC.PROVIDER_ECONOMICS),

  priceToken: () => ipcRenderer.invoke(IPC.PRICE_TOKEN),

  leaseList: () => ipcRenderer.invoke(IPC.LEASE_LIST),
  leaseParams: () => ipcRenderer.invoke(IPC.LEASE_PARAMS),
  leaseQuote: (nodeAddress: string, hours: number) => ipcRenderer.invoke(IPC.LEASE_QUOTE, { nodeAddress, hours }),
  leaseStart: (params: unknown) => ipcRenderer.invoke(IPC.LEASE_START, params),
  leaseEnd: (leaseId: string) => ipcRenderer.invoke(IPC.LEASE_END, { leaseId }),

  onPlanDiscoverProgress: (callback: (progress: { done: number; total: number; phase: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { done: number; total: number; phase: string }) => {
      callback(progress)
    }
    ipcRenderer.on(IPC.PLAN_DISCOVER_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC.PLAN_DISCOVER_PROGRESS, handler)
    }
  },
})
