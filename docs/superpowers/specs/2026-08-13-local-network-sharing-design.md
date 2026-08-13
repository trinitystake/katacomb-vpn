# Local Network Sharing — design

Date: 2026-08-13
Status: approved, not yet implemented

## Problem

With the kill switch armed, the user cannot reach other machines on their own
LAN — `ssh 192.168.1.50` from the VPN host times out. Mullvad solves this with a
"Local network sharing" toggle. This spec adds the equivalent.

### It is not the existing Split Tunneling setting

`settings.splitTunnelRoutes` is a **routing** bypass and is read in exactly one
place — `vpn-manager.ts` `bringUpTun()` — where it becomes
`ip route <cidr> via <real gateway>` arguments to the helper's `tun-up` verb.
That path exists only for the tun2socks protocols (V2Ray, XRAY, Hysteria2). For
WireGuard, AmneziaWG and OpenVPN the setting is loaded and never used.

### What actually blocks the LAN

`killswitch-on` in `resources/linux/katacomb-vpn-helper.sh` builds an OUTPUT
chain accepting only `lo`, the tunnel interface, the node IP, DHCP, DNS through
the tunnel, and `ESTABLISHED,RELATED` — then `-j DROP`. A new SSH SYN to a LAN
address egresses the physical NIC, matches nothing, and is dropped.

Inbound connections *to* this machine are unaffected: the chain never touches
INPUT, and the replies ride the ESTABLISHED accept.

### Routing already works — verified, not assumed

No routing change is needed for any of the six protocols, because in every case
the LAN's own route is more specific than what the tunnel installs:

- **WireGuard / AmneziaWG** — wg-quick/awg-quick install `0.0.0.0/0` in a
  separate table plus `ip rule … table main suppress_prefixlength 0`, which
  consults the main table while ignoring only its default route. More-specific
  LAN routes survive.
- **OpenVPN** — `openvpn-config.ts` emits `redirect-gateway def1`, i.e. the
  `0.0.0.0/1` + `128.0.0.0/1` pair rather than replacing the default route.
- **V2Ray / XRAY / Hysteria2** — `tun-up` installs the same `/1` halves.

A directly attached `192.168.x.0/24` link route beats `/1` and is exempt from
`suppress_prefixlength 0`. A non-attached LAN range reached via the router is
likewise a non-default route in the main table and survives for the same reason.

**Therefore this feature is purely a firewall exception.** No routing changes,
no new privileged verb, no daemon protocol version bump.

### Secondary finding: the toggles are connect-time only

Observed behaviour, confirmed in code:

| Before connect | Toggle while connected | Result |
| --- | --- | --- |
| Kill switch ON | — | LAN blocked |
| Kill switch OFF | switch ON | LAN still reachable (chain never armed) |
| Kill switch ON | switch OFF | LAN still blocked (chain never torn down) |

`Settings.tsx` only persists the boolean. Arming happens once in
`applyPostConnectSettings()`; teardown keys off the *armed marker*, not the
setting — deliberately, per the comment above `revertPostConnectSettings()`.
The behaviour is intentional but the UI ("Block all traffic if VPN drops")
gives no hint of it, so it reads as a bug. This spec makes both toggles apply
live, which removes the ambiguity rather than documenting it.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Scope of "local network" | Fixed private ranges, hardcoded | Mullvad parity; nothing to misconfigure; cannot become a hole to a public address |
| Auto-detected subnets | Rejected | Goes stale on network change (dock, Wi-Fi roam) and would need live re-detection machinery this app does not have |
| Reuse `splitTunnelRoutes` | Rejected | Overloads one control with two meanings, and that box accepts any public CIDR — which would become a real leak |
| Live toggle | Yes, both settings | Removes the confusion above; `killswitch-on` already rebuilds the chain, so a re-arm is one idempotent call |
| Default | Off | Matches Mullvad, and does not silently weaken the posture of existing kill-switch users on upgrade |

## Design

### The rules

New `AppSettings` field `lanSharing: boolean`, default `false`, alongside
`killSwitch`. When on, `killswitch-on` inserts these ACCEPTs **before** the
terminal DROP:

```
-d 10.0.0.0/8        # RFC1918
-d 172.16.0.0/12
-d 192.168.0.0/16
-d 169.254.0.0/16    # link-local
-d 224.0.0.0/4       # multicast
-d 255.255.255.255   # broadcast
```

and on the IPv6 chain, before its DROP: `fe80::/10` (this also unbreaks
neighbour discovery, which `ipv6_killswitch_on` drops today), `fc00::/7`,
`ff00::/8`.

**The ranges are a constant in the helper.** They are not passed from the app,
not user-editable, and not derived from anything a node sends. The only value
crossing the trust boundary is one boolean.

An `ACCEPT` in OUTPUT permits, it does not route. A packet only reaches the
physical NIC if the routing table already decided the destination was local, so
these rules cannot pull tunnel traffic out of the tunnel.

### Threading the flag

| File | Change |
| --- | --- |
| `src/main/settings.ts` | `lanSharing: boolean` on `AppSettings` + `false` in `DEFAULT_SETTINGS` |
| `src/renderer/types/index.ts` | mirror the field on the renderer's `AppSettings` |
| `src/main/kill-switch.ts` | `enableKillSwitch(iface, remoteHost, { dnsIp, lanSharing })` — options object rather than a fourth positional boolean |
| `src/main/privileged.ts` | append / parse a `lan-sharing` sentinel token on the `killswitch-on` argv |
| `src/main/daemon-core.ts` | validate `typeof a.lanSharing === 'boolean'` in the `killswitch_on` op, append the token to `helperArgs` |
| `resources/linux/katacomb-vpn-helper.sh` | accept the token, emit the v4 + v6 ACCEPT rules |
| `src/main/ipc-handlers.ts` | allow-list the settings key; factor `armKillSwitch()`; live re-apply |
| `src/renderer/components/Settings.tsx` | the toggle |

The sentinel token rather than a fourth positional argument: `dnsIp` is
optional, so a positional LAN flag would require passing an empty string for
it, which the daemon's `isIPv4` check would then reject. The token is
recognised only as the final argument; it can collide with neither an interface
name (positional `$2`) nor a DNS IP.

Adding an optional field to an existing daemon op is additive — the same
precedent as the amneziawg and openvpn ops — so no protocol version bump. A
stale daemon paired with a new GUI ignores the field and leaves the LAN
blocked; this is transient, since the deb ships both and the postinst restarts
the unit.

### Live application

Factor the arm block out of `applyPostConnectSettings()` into `armKillSwitch()`,
which records what it armed with (`iface`, `remoteHost`, `dnsIp`) in
module-level state cleared on teardown. Re-arming then replays those exact
values instead of re-deriving the protocol and endpoint.

`SETTINGS_SET`, running **inside `withConnectionLock`** so it cannot race a
connect or disconnect:

The armed marker, not the connection state, decides. Cases in order:

- `killSwitch` turned off and the chain is armed → disarm. This holds even with
  no tunnel up, which is what provides an escape from the "expired, traffic
  blocked" stand-down state without a restart.
- `lanSharing` changed and the chain is armed → re-arm with the new flag,
  replaying the recorded `armKillSwitch()` values. Also holds in the stand-down
  state, where those values are still recorded because teardown has not run.
- `killSwitch` turned on, the chain is not armed, and a **full-tunnel**
  connection is active → arm.
- Anything else → persist only. That covers disconnected-and-not-armed (arming
  with no tunnel would black-hole the machine) and proxy mode, which never arms
  the kill switch by design.

On the AppImage and `npm run dev` (no daemon) each toggle costs one `pkexec`
prompt. Acceptable: the user just clicked it.

### UI

A toggle nested under Kill Switch in the VPN Security group of Settings →
General, disabled while the kill switch is off — it has no effect there, since
the LAN is already reachable — with copy stating that. Both toggles now apply
immediately, so no "applies from your next connection" note is required.

## Verification

Static:

- `npm run typecheck` clean
- `npm test` clean, with new `daemon-core.test.ts` cases: a non-boolean
  `lanSharing` never reaches `helperArgs`; `true` appends the token; the
  existing three-argument form is unchanged

Live, connected with the kill switch on:

1. `ssh <lan-box>` fails; toggle Local Network Sharing on; it succeeds **without
   reconnecting**
2. `sudo iptables -S KATACOMB_KILLSWITCH` shows the ACCEPTs above the DROP;
   toggling off removes them
3. `curl https://ifconfig.me` still returns the VPN IP, and a probe to a public
   address is still dropped — proving the exception did not widen into a leak
4. IPv6: `ping6 fe80::…%<nic>` reaches a LAN neighbour with the toggle on

## Out of scope

- Auto-detected subnets and user-editable LAN ranges
- Wiring `splitTunnelRoutes` into the firewall
- Touching the INPUT chain — it is never filtered, and inbound connections to
  this machine already work
- `${RUN_DIR}/killswitch.state` is written by `killswitch-on` and never read
  back anywhere in the tree. Pre-existing dead state; noted, not removed.
