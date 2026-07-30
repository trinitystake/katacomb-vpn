// Prefixes on Error messages that cross the IPC bridge and mean something
// specific to the renderer. Kept as plain string markers (not error classes)
// because only `message` survives ipcRenderer.invoke's rejection.

/**
 * A WireGuard/AmneziaWG bring-up failed at the DNS step — wg-quick/awg-quick
 * couldn't run `resolvconf`. The tunnel is otherwise fine, so the renderer
 * offers a retry with `DNS =` stripped (system DNS, outside the tunnel).
 */
export const DNS_PROVISION_FAILED = 'DNS_PROVISION_FAILED'
