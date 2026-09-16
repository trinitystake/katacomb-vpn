# Node protocol types

All six protocols and how each one differs. `src/main/protocols/` holds the
config builders; `src/renderer/utils/protocols.ts` is the single source of
truth for labels, badges and the supported flag.

`SentNode.type` is a **numeric** protocol tag from the `api.sentnodes.com/v2/nodes`
feed: `0`=unknown, `1`=WireGuard, `2`=V2Ray, `3`=OpenVPN, `4`=XRAY, `5`=AmneziaWG,
`6`=Hysteria2. **Each node runs exactly ONE protocol** — a node's own `/info`
endpoint reports a single `service_type` (verified against dvpnx master + live
v9.0.0 nodes). The v9.0.0 "six protocols" marketing means six protocol *types*
exist across the network, NOT six per node; multi-protocol operators register
several separate nodes. Do not build a per-node "protocols array" model — there's
no aggregator field for it.

`src/renderer/utils/protocols.ts` is the **single source of truth** for protocol
label / short badge / semantic color / `supported` flag — use `protocolMeta(type)`
and `isProtocolSupported(type)` instead of inline `type === 1 ? …` ternaries (which
assume a two-protocol world). The Nodes-tab protocol filter is a single-select
`<select>` in `NodeFilters.tsx` driven by `PROTOCOL_FILTER_OPTIONS`; `NodeFilter.type`
is `'all' | ProtocolType`.

**All six protocols are connectable: WireGuard (1), V2Ray (2), OpenVPN (3), XRAY (4),
AmneziaWG (5), Hysteria2 (6).** Only type 0 (unknown) is not. The main-process IPC
guards (`nodeType` not in `{1,2,3,4,5,6}` → throw) plus `isProtocolSupported` in the
connect UI are the enforcement. Any *future* protocol needs its own binary, config
generation/validation, and (for root-run ones) a privileged daemon op.

**XRAY** is the VLESS+Reality protocol and reuses almost the entire V2Ray path: it's
a v2ray-core fork that reads the **same JSON config**, so it runs through the same
`config-guard` transforms (`pinV2RayNodeAddresses`/`withV2RayDiagnosticLog`/
`assertSafeV2RayConfig`/`withV2RayDoH`), the same tun2socks routing (`bringUpTun`),
and the same child-process lifecycle (`spawnV2Ray` — generalized to take a
bin/args/logName; `isChildProxy()` narrows v2ray+xray together at the branch sites).
What differs:
- The bundled JS SDK **cannot** build Reality configs — its `V2RayMetadata`
  type has no `flow`/`reality_*` fields and `V2Ray.parseConfig` ignores them — so
  `src/main/protocols/xray-config.ts` (`buildXRayConfig`, pure + unit-tested) builds the xray
  VLESS+Reality JSON from the node's handshake metadata. Enum decode confirmed via the
  aggregator: `proxy_protocol 1=vless`, `transport_protocol 1=tcp`, `transport_security
  1=none/2=tls/3=reality`, `flow 2=xtls-rprx-vision`. It only ever selects reality/tls
  entries (never `none`), which is what keeps an xray tunnel from being cleartext.
- The handshake reuses the generic `sdkHandshake(sid, { uuid }, …)` (VLESS peer
  material is a UUID, same as V2Ray); `performHandshake`'s `nodeType === 4` branch
  generates the uuid from an SDK `V2Ray` instance purely for that.
- A separate **`xray`** binary is bundled in `resources/linux/bin/` (Xray-core
  official release, SHA-pinned in `binary-integrity.ts` — vendor + verify checksum +
  update the pin when upgrading). `extraResources` ships everything under that dir.

**Hysteria2** (type 6) is a QUIC protocol — NOT a v2ray-core fork — but it still reuses
the child-process + tun2socks tunnel path because the `hysteria` client exposes a local
SOCKS5 listener (`isChildProxy()` narrows v2ray+xray+hysteria2 together). What differs:
- Its own bundled **`hysteria`** binary (apernet/hysteria, SHA-pinned in
  `binary-integrity.ts`; CLI `hysteria client -c <file>`, JSON config via viper by `.json`
  ext) in `resources/linux/bin/`.
- The SDK has no Hysteria2 class at all, so `src/main/protocols/hysteria-config.ts`
  (`buildHysteria2Config`, pure + unit-tested) synthesizes the whole client config from a
  few handshake-metadata scalars: `server`/`auth`(=uuid)/`tls{insecure:true,pinSHA256}`/
  `socks5{listen:127.0.0.1:1080}`/`lazy:true` (+ optional salamander `obfs`). Fields taken
  verbatim from the go-sdk `hysteria2/` package (metadata = `{port, tls_pin, obfs_password}`).
- **Its config shape has no `outbounds`/`vnext`,** so `assertSafeV2RayConfig` and the v2ray
  DoH/pin transforms DON'T apply — it has its own `assertSafeHysteria2Config` (require
  `server` host:port, loopback socks5, a valid `tls.pinSHA256`; reject `acl`/`outbounds`),
  and `extractV2RayRemoteHost` was generalized to also read hysteria2's `server` field (for
  the tun2socks bypass route AND the kill-switch whitelist — the kill switch's
  `-d host -j ACCEPT` is protocol-agnostic, so QUIC/UDP works with no helper change).
- **Security gate = the TLS pin** (hysteria2's Reality analog): self-signed cert, safe only
  when pinned via `tls.pinSHA256`; a pin-less node → `buildHysteria2Config` throws → refund.
- Hysteria2 gets the `dns-set` (tun2socks needs a tunnel-routed resolver) but NOT the
  in-config DoH injection (v2ray-shaped only) → its DNS is plaintext-through-tunnel, like WG.
- **UUID-format gotcha (cost a live 500):** the SDK's `V2Ray.getKey()` returns the uuid as a
  16-BYTE ARRAY, which v2ray/xray's node field (`uuid.UUID`) accepts but hysteria2's
  (`UUID string`) rejects (JSON array → Go string = unmarshal error → HTTP 500). The
  hysteria2 handshake mints a `randomUUID()` STRING and reuses it as the config `auth`. Only
  use `getKey()` for protocols whose node peer field is `uuid.UUID`.

**AmneziaWG** (type 5) is a WireGuard fork with DPI-evasion params and rides the WG
**root/privileged path** (helper + daemon), NOT the tun2socks child-proxy path
(`isChildProxy` must never include it). What differs from plain WG:
- The SDK can't emit the obfuscation keys, so `src/main/protocols/amneziawg-config.ts`
  (`buildAmneziaWgConfig`, pure + unit-tested) builds the awg INI from handshake
  metadata (go-sdk `amneziawg/metadata.go`: `{port, public_key, s1..s4, h1..h4,
  i1..i5?}`). The handshake payload is the same `{public_key}` as WG — the SDK
  `Wireguard` class is used for keygen only. **Nodes never send `Jc/Jmin/Jmax`** —
  the client generates them (Jc [3,10], Jmin [64,256], Jmax [512,1024], the SDK's
  own defaults). Constraint re-checks (S1+56≠S2; H1-H4 all-zero or all distinct >4;
  I1-I5 tag grammar) throw → refund.
- **No vendored binaries since Phase 3.** The userspace device is
  `github.com/amnezia-vpn/amneziawg-go` **linked into the helper** as the hidden
  `_amneziawg` sub-mode (`daemon/internal/amneziawg`), self-exec'd by `awg-up` from
  `/usr/local/bin` exactly like `_tun2socks` — which is what made AmneziaWG work on the
  AppImage, where root cannot read the FUSE mount the old `awg-quick`/`awg`/
  `amneziawg-go` trio lived on. It reads the root-owned `/run/katacomb-vpn/sntl0.conf`,
  translates the wg(8) INI to the WireGuard UAPI itself (`ToUAPI`: base64 keys → hex,
  jc/jmin/jmax/s1-s4/h1-h4/i1-i5 passthrough, `fwmark=51820` injected) and never opens
  a UAPI socket. The `awg-quick(8)` work around it — addresses, MTU (route MTU − 80),
  DNS via an exec of `resolvconf -a sntl0`, the fwmark rule pair + `/0` route in table
  51820, `src_valid_mark=1` — is a **behavioural reimplementation from wg-quick(8) and
  the UAPI spec** in `daemon/internal/ops/amneziawg.go`, never a port: `amneziawg-tools`
  is GPL-2.0-only and nothing from it is linked or translated, so the project's only
  copyleft obligation went with the trio. Deliberate deviations: no anti-spoof nft
  firewall (the tun2socks path never had one; validated by a real handshake), IPv6
  routing best-effort, the kernel `amneziawg` module never tried.
- **The `amneziawg-go` pin tracks `sentinel-dvpnx`'s `AMNEZIAWG_GO_COMMIT`, never
  upstream latest** (today `1cc9427` = `v0.2.19` = **AmneziaWG 2.0**, the protocol every
  node speaks; verify against dvpnx's `Dockerfile` before any bump). AmneziaWG 3.x
  (`v3.0.0`+, upstream HEAD `v3.1.x`) is a **wire-protocol break** — `header_protection_key`
  replaces the static H1–H4, plus random trailers/padding and randomized timers — so a
  3.x client cannot handshake with a 2.0 node; a network move is node-led (go-sdk
  `ServerMetadata` → dvpnx pin → our `amneziawg-config.ts` → the guard corpus →
  `ToUAPI` → `go.mod`). The Go module proxy lists phantom `v1.0.x` tags that are not in
  the repo; ignore them.
- **`scripts/verify-awg-handshake.sh` is the acceptance test**: two containers, the
  server built from the dvpnx-pinned upstream commits under the real `awg-quick`, the
  client our helper's `awg-up`; ICMP+HTTP through the tunnel proves the translation and
  the routing (28 checks, with and without DNS). A wrong `ToUAPI` shows up there as "no
  handshake" and nowhere else. `amneziawg_ops_test.go` pins the native command sequence
  against the recording Env (an authored test, not a bash golden: awg-quick's firewall
  goes through process substitution and is unobservable in an argv transcript).
- Helper verbs `awg-up <config> <bindir>` / `awg-down` — **`<bindir>` is accepted and
  IGNORED** (the `tun-up <bin>` convention; the app passes `-`) so old and new helpers
  share one argv contract; daemon ops `amneziawg_up` / `amneziawg_down` (additive — no
  protocol-version bump); `guard.AssertAmneziaWgConfig` in `daemon/` is the root-side
  mirror of `assertSafeAmneziaWgConfig` (allow-list = WG keys + jc/jmin/jmax/s1-s4/
  h1-h4/i1-i5; PostUp/PreUp still rejected — a hook line is a root-shell vector whatever
  consumes the file), pinned to it by the shared corpus. `awg-down` SIGTERMs the pid in
  `awg.state` (else a `/proc` scan matching only our own `_amneziawg` process), deletes
  the link, repairs the rule pair via `cleanupWgRules`, undoes `resolvconf -d`.
- **The tunnel reuses iface `sntl0`** so kill switch, `/proc/net/dev` traffic stats, the
  WG liveness monitor and daemon status work unchanged — BUT a userspace AWG `sntl0` is
  `type tun`, not `type wireguard`, so every "sntl0 ⇒ kernel WG" assumption branches on
  `sntl0IsKernelWireGuard()` (teardown via `ensureSntl0Down`, adoption, status,
  `detectOtherVpn` exclusion). DNS is provisioned through `resolvconf` like wg-quick —
  no `dns-set`, no DoH — and a missing `resolvconf` still fails the bring-up with the
  `/resolvconf/i` text that drives `DNS_PROVISION_FAILED`.

**OpenVPN** (type 3) also rides the **root/privileged path** (`isChildProxy` must never
include it). The wire shape is identical at go-sdk master and the commit node v8.3.1
pins, so one implementation covers the whole network:
- Handshake request is `{uuid}` as a **16-BYTE ARRAY** (node field is v2fly
  `uuid.UUID` = `[16]byte`) — the opposite of hysteria2's string field. The uuid is
  only the peer id: the node's PKI *issues the client certificate*, so the response is
  `{metadata:[{port, protocol:"tcp"|"udp", ca:b64(DER), tls:b64(256-byte tls-crypt)}],
  cert:b64(DER), key:b64(DER PKCS#8)}`. There is **no `addrs`** in the body (the
  OpenVPN server pushes the tunnel IP) — the endpoint comes from `result.addrs`.
- `src/main/protocols/openvpn-config.ts` (`buildOpenVpnConfig`, pure + unit-tested) emits ONE
  self-contained `.ovpn` with **inline `<ca>/<cert>/<key>/<tls-crypt>` blocks** — not
  the go-sdk's config-plus-four-PKI-files layout. That is what lets it live in
  `SavedSessionConfig.configString` (reconnect works) and be shipped to the daemon as
  content. Every blob is base64-**decoded and re-armored by us**, so no node byte can
  become a directive; `ca`/`cert` must parse as X.509 and `key` as a private key
  (node:crypto), and the tls-crypt key must be exactly 256 bytes — all throw → refund.
  The endpoint is IPv4-pinned (a hostname `remote` would deadlock on reconnect with the
  kill switch armed). `management 127.0.0.1 2323` from the upstream template is dropped.
- **The security boundary is the directive allow-list**, not a blocklist:
  `up`/`down`/`route-up`/`ipchange`/`client-connect`/`tls-verify`/
  `auth-user-pass-verify`/`learn-address`/`plugin`/`script-security` all run code as
  root and are rejected by omission (`assertSafeOpenVpnConfig`, mirrored on the root
  side by `guard.AssertOpenVpnConfig`). It also **requires** `client` + all four PKI blocks and
  rejects a repeated `remote` (the kill switch only whitelists the first).
  Operational flags are deliberately NOT allowed in the file — the helper passes
  `--script-security 0 --dev sntl-ovpn --daemon --writepid --log --connect-*` on the
  command line *after* `--config` (openvpn is last-one-wins), so they can only come
  from us. **Invariant: anything the guard rejects is supplied by the helper.**
- **Distro binary, not bundled**: `deb.depends` gains `openvpn`, resolved from an
  absolute allow-list (`/usr/sbin/openvpn`, …) — never `$PATH` under root. This is the
  plain-WireGuard model (system `wg-quick`), chosen over vendoring because openvpn is a
  TLS client and distro packaging ships the OpenSSL CVE fixes.
- **Own interface `sntl-ovpn`** (not sntl0): a userspace AWG sntl0 is already
  `type tun`, so a third tun there would make adoption/teardown ambiguous
  (`awg-down` ≠ `ovpn-down`). Costs only `traffic-stats`' third fallback,
  `ops.Status`'s `ovpnUp` (daemon/), the `detectOtherVpn` exclusion and the
  `vpnIface` ternary — all two-way, no new discriminator.
- **openvpn stays resident** (wg-quick/awg-quick exit), so `ovpn-up` daemonizes it and
  then **waits for proof**: `sntl-ovpn` present AND "Initialization Sequence Completed"
  in the log, else it kills the pid and returns the log tail (that text reaches the
  connect modal). `ovpn-down` kills the pid, waits, then deletes the link. Liveness is
  interface polling (`startRootTunnelMonitor`, shared with WG/AWG) — there is no child
  process to watch, since root owns it.
- Helper verbs `ovpn-up <config>` / `ovpn-down`; daemon ops `openvpn_up` /
  `openvpn_down` (additive — no protocol-version bump).
- **DNS is ours, not the tunnel's.** Applying the server's pushed DNS would need an
  `--up` script (the LPE vector), so OpenVPN joins the `dns-set` group with
  v2ray/xray/hysteria2 — plaintext-through-tunnel, and NOT the DoH group (that
  transform is v2ray-JSON-shaped). Consequently there is **no `DNS_PROVISION_FAILED`
  path**: `dnsFallback`/`stripDnsLines` stay WG/AWG-only.

**Connection modes.** `ConnectParams.mode` is `'tunnel'` (default, routes the whole
device) or `'proxy'`. Local-proxy mode applies ONLY to the child-proxy protocols
(v2ray/xray/hysteria2 — the ones with a local SOCKS5 listener at `127.0.0.1:1080`):
it spawns the core and stops there — no tun2socks, no root, no password prompt. The
branches skip `bringUpV2RayTunnel()` AND `applyPostConnectSettings()`, so **proxy mode
leaks by design** (only apps pointed at the SOCKS address are tunneled) and the
kill-switch setting is deliberately ignored. WG/AWG + `mode:'proxy'` throws. Keep
`isVpnActive()` meaning "system traffic is redirected" — it returns FALSE in proxy
mode, because routing is untouched and callers must not fall back to cached chain
data. The mode is runtime-only (never in `SavedSessionConfig`): auto-reconnect replays
`desiredMode`, a session-tab reconnect is always full-tunnel.
