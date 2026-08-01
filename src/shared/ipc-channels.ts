export const IPC = {
  // Wallet
  WALLET_HAS_STORED: 'wallet:has-stored',
  WALLET_GENERATE: 'wallet:generate',
  WALLET_IMPORT: 'wallet:import',
  WALLET_GET_ADDRESS: 'wallet:get-address',
  WALLET_GET_BALANCE: 'wallet:get-balance',
  WALLET_LOGOUT: 'wallet:logout',
  WALLET_SESSIONS: 'wallet:sessions',
  WALLET_END_SESSION: 'wallet:end-session',
  WALLET_LIST: 'wallet:list',
  WALLET_SWITCH: 'wallet:switch',
  WALLET_DELETE: 'wallet:delete',
  WALLET_DELETE_ALL: 'wallet:delete-all',
  WALLET_RENAME: 'wallet:rename',
  WALLET_STORE_STATUS: 'wallet:store-status',
  WALLET_DERIVE_SUBACCOUNT: 'wallet:derive-subaccount',
  WALLET_DERIVE_PREVIEW: 'wallet:derive-preview',
  WALLET_REVEAL_MNEMONIC: 'wallet:reveal-mnemonic',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Nodes
  NODES_FETCH: 'nodes:fetch',
  NODES_GET_CACHED: 'nodes:get-cached',

  // Connection
  CONNECTION_SUBSCRIBE: 'connection:subscribe',
  CONNECTION_RECONNECT: 'connection:reconnect',
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_CHECK_VPN: 'connection:check-vpn',
  CONNECTION_DISCONNECT: 'connection:disconnect',
  CONNECTION_STATUS: 'connection:status',

  // Network
  NETWORK_GET_IP: 'network:get-ip',

  // Traffic
  TRAFFIC_STATS: 'traffic:stats',

  // Bookmarks
  BOOKMARK_TOGGLE: 'bookmark:toggle',
  BOOKMARK_LIST: 'bookmark:list',

  // Node Testing
  NODE_TEST_PROBE: 'node-test:probe',
  NODE_TEST_BATCH: 'node-test:batch',
  NODE_TEST_SPEED: 'node-test:speed',
  NODE_TEST_CANCEL: 'node-test:cancel',
  NODE_TEST_RESULTS: 'node-test:results',

  // RPC health
  RPC_HEALTH_GET: 'rpc:health-get',
  RPC_PROBE_ALL: 'rpc:probe-all',

  // Binary checks
  BINARY_CHECK: 'binary:check',

  // Plan-based subscriptions
  PLAN_DISCOVER: 'plan:discover',
  PLAN_LIST_CACHED: 'plan:list-cached',
  PLAN_ALLOCATIONS: 'plan:allocations',
  PLAN_SUBSCRIBE: 'plan:subscribe',
  PLAN_START_SESSION_FROM_SUB: 'plan:start-session-from-sub',
  PLAN_NODES: 'plan:nodes',
  PLAN_LIST_FOR_NODE: 'plan:list-for-node',

  // Subscription management (cancel / renew / auto-renewal policy)
  SUBSCRIPTION_LIST: 'subscription:list',
  SUBSCRIPTION_CANCEL: 'subscription:cancel',
  SUBSCRIPTION_RENEW: 'subscription:renew',
  SUBSCRIPTION_UPDATE_POLICY: 'subscription:update-policy',

  // Providers
  PROVIDER_GET: 'provider:get',
  PROVIDER_LIST: 'provider:list',

  // Provider console — acting AS a provider with this wallet
  PROVIDER_ME: 'provider:me',
  PROVIDER_MODE_SET: 'provider:mode-set',
  PROVIDER_DEPOSIT: 'provider:deposit',
  PROVIDER_REGISTER: 'provider:register',
  PROVIDER_UPDATE_DETAILS: 'provider:update-details',
  PROVIDER_SET_STATUS: 'provider:set-status',
  PROVIDER_PLANS: 'provider:plans',
  PROVIDER_PLAN_CREATE: 'provider:plan-create',
  PROVIDER_PLAN_SET_STATUS: 'provider:plan-set-status',
  PROVIDER_PLAN_LINK: 'provider:plan-link',
  PROVIDER_PLAN_UNLINK: 'provider:plan-unlink',
  PROVIDER_PLAN_STATS: 'provider:plan-stats',
  PROVIDER_ECONOMICS: 'provider:economics',

  // Token price in USD (display only — never used to price a transaction)
  PRICE_TOKEN: 'price:token',

  // Leases (x/lease — the prerequisite for linking a node to a plan)
  LEASE_LIST: 'lease:list',
  LEASE_PARAMS: 'lease:params',
  LEASE_QUOTE: 'lease:quote',
  LEASE_START: 'lease:start',
  LEASE_END: 'lease:end',

  // Events (main → renderer)
  CONNECTION_PROGRESS: 'connection:progress',
  CONNECTION_STATE_CHANGE: 'connection:state-change',
  CONNECTION_RECONNECTING: 'connection:reconnecting',
  // Tray "Connect" → ask the renderer to reconnect to the most recent session.
  CONNECTION_TRAY_CONNECT: 'connection:tray-connect',
  NODE_TEST_PROGRESS: 'node-test:progress',
  NODES_UPDATE: 'nodes:update',
  PLAN_DISCOVER_PROGRESS: 'plan:discover:progress',
  RPC_HEALTH_UPDATE: 'rpc:health-update',
} as const
