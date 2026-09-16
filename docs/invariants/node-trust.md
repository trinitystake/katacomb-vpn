# Node-trust invariant

VPN node operators are adversaries in this app's threat model. Their handshake
data becomes config that the privileged helper runs as root. Read this before
adding any path that turns node-supplied data into a file, a spawn or a route.

**VPN node operators are adversaries in this app's threat model.** Their handshake
data becomes WireGuard/V2Ray configs and split-tunnel routes that the polkit helper
runs as **root** (`wg-quick`, `iptables`, `ip route`). A `wg-quick` config with a
`PostUp = …` directive executes shell as root — so any code path that turns
node-supplied (or renderer-supplied) data into a `.conf` / spawn / route MUST pass it
through `config-guard.ts` first. `vpn-manager.ts` enforces this at the sinks
(`connectWireGuard*`, `connectV2Ray*`, `bringUpTun`); never add a path that writes
node-derived data to disk or hands it to the helper without a `config-guard` check.
Likewise, tunnel credentials are only persisted when `safeStorage` is available —
never fall back to writing them in plaintext.

**And the channel that delivers a node's keys authenticates nothing.** The SDK's
handshake POST and `node-tester.ts` both set `rejectUnauthorized: false`, so the TLS pin,
the Reality public key, the port and `addrs` all arrive over a connection that accepts any
certificate — and those are precisely what the tunnel's confidentiality then rests on. An
on-path attacker (the ISP) can answer the handshake with its own metadata and become the
node; `normalizeTlsPin` and the config builders will faithfully pin the attacker's
certificate. There is **nothing on chain to verify against**: `sentinel/node/v3/node.proto`
gives `Node` only `{address, gigabyte_prices, hourly_prices, remote_addrs, inactive_at,
status, status_at}` — no certificate, fingerprint or public key. Trust-on-first-use
pinning is therefore the only option that exists, and it is deliberately **not
implemented** (it changes the failure mode of every connect and can't be validated without
live nodes). So never write UI copy implying that the TLS/Reality wrapping defeats the
local network; multihop's threat-model block states the limit instead.
