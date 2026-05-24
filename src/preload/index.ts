import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'

contextBridge.exposeInMainWorld('api', {
  walletHasStored: () => ipcRenderer.invoke(IPC.WALLET_HAS_STORED),
  walletGenerate: (wordCount: 12 | 24) => ipcRenderer.invoke(IPC.WALLET_GENERATE, wordCount),
  walletImport: (mnemonic: string) => ipcRenderer.invoke(IPC.WALLET_IMPORT, mnemonic),
  walletGetAddress: () => ipcRenderer.invoke(IPC.WALLET_GET_ADDRESS),
  walletGetBalance: () => ipcRenderer.invoke(IPC.WALLET_GET_BALANCE),
  walletLogout: () => ipcRenderer.invoke(IPC.WALLET_LOGOUT),
  walletSessions: () => ipcRenderer.invoke(IPC.WALLET_SESSIONS),
  walletEndSession: (sessionId: string) => ipcRenderer.invoke(IPC.WALLET_END_SESSION, sessionId),
  walletList: () => ipcRenderer.invoke(IPC.WALLET_LIST),
  walletSwitch: (walletId: string) => ipcRenderer.invoke(IPC.WALLET_SWITCH, walletId),
  walletDelete: (walletId: string) => ipcRenderer.invoke(IPC.WALLET_DELETE, walletId),
  walletRename: (walletId: string, newName: string) => ipcRenderer.invoke(IPC.WALLET_RENAME, walletId, newName),

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
  networkGetIp: (includeGeo?: boolean) => ipcRenderer.invoke(IPC.NETWORK_GET_IP, includeGeo),

  trafficStats: () => ipcRenderer.invoke(IPC.TRAFFIC_STATS),

  bookmarkToggle: (nodeAddress: string) => ipcRenderer.invoke(IPC.BOOKMARK_TOGGLE, nodeAddress),
  bookmarkList: () => ipcRenderer.invoke(IPC.BOOKMARK_LIST),

  rpcCheck: (endpoint: string) => ipcRenderer.invoke(IPC.RPC_CHECK, endpoint),

  binaryCheck: () => ipcRenderer.invoke(IPC.BINARY_CHECK),

  nodeTestProbe: (params: { nodeAddress: string; remoteUrl: string }) =>
    ipcRenderer.invoke(IPC.NODE_TEST_PROBE, params),
  nodeTestBatch: (nodes: Array<{ nodeAddress: string; remoteUrl: string }>) =>
    ipcRenderer.invoke(IPC.NODE_TEST_BATCH, nodes),
  nodeTestSpeed: () => ipcRenderer.invoke(IPC.NODE_TEST_SPEED),
  nodeTestCancel: () => ipcRenderer.invoke(IPC.NODE_TEST_CANCEL),
  nodeTestResults: () => ipcRenderer.invoke(IPC.NODE_TEST_RESULTS),

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

  planDiscover: (maxId: number) => ipcRenderer.invoke(IPC.PLAN_DISCOVER, maxId),
  planListCached: () => ipcRenderer.invoke(IPC.PLAN_LIST_CACHED),
  planAllocations: () => ipcRenderer.invoke(IPC.PLAN_ALLOCATIONS),
  planSubscribe: (params: unknown) => ipcRenderer.invoke(IPC.PLAN_SUBSCRIBE, params),
  planStartSessionFromSub: (params: unknown) => ipcRenderer.invoke(IPC.PLAN_START_SESSION_FROM_SUB, params),
  planNodes: (planId: string) => ipcRenderer.invoke(IPC.PLAN_NODES, { planId }),
  planListForNode: (nodeAddress: string) => ipcRenderer.invoke(IPC.PLAN_LIST_FOR_NODE, { nodeAddress }),

  providerGet: (address: string) => ipcRenderer.invoke(IPC.PROVIDER_GET, { address }),
  providerList: () => ipcRenderer.invoke(IPC.PROVIDER_LIST),

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
