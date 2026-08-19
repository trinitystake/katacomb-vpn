// Single source of truth for the child proxies' local SOCKS5 listener.
// vpn-manager (tun2socks dial + status socksAddr) and the renderer copy import
// these. The Electron-free config builders (xray-config, hysteria-config,
// multihop-config) inline the port so the native test runner can load them
// directly; their tests assert the emitted configs match these values (the
// same arrangement as connect-errors.ts vs error-markers.ts).
export const SOCKS_PORT = 1080
export const SOCKS_DISPLAY_ADDR = `127.0.0.1:${SOCKS_PORT}`
