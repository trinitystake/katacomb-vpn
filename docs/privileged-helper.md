# Privilege escalation and the privileged helper

One Go binary, two doors: a root daemon behind a Unix socket (deb) and a
pkexec one-shot (AppImage, dev). `daemon/` is the whole root side;
`src/main/helper/` is the app side.

VPN operations require root. Instead of raw `pkexec wg-quick`, the app uses ONE
privileged program, **`katacomb-vpn-helper`**: a static Go binary built from `daemon/`
by `scripts/build-daemon.sh` into `resources/linux/privileged/` (gitignored; built on
every `npm run build`/`dist`/`dev`). `resources/linux/` is laid out by role: `bin/`
(vendored binaries beside their licence texts), `privileged/` (what postinstall copies
onto the system), `packaging/` (the deb maintainer scripts, deliberately NOT shipped
inside the package):
- `resources/linux/privileged/katacomb-vpn-helper` — installed to `/usr/local/bin/katacomb-vpn-helper`
- `resources/linux/privileged/com.katacomb.vpn.policy` — polkit policy for cached auth (pins that path)
- `resources/linux/privileged/katacomb-vpn-daemon.service` — systemd unit, `ExecStart=/usr/local/bin/katacomb-vpn-helper daemon`
- `resources/linux/packaging/postinstall.sh` — deb postinstall that deploys the helper + policy + unit
- One binary, five entry modes: `katacomb-vpn-helper daemon` (systemd; serves protocol
  v1 on the socket), `katacomb-vpn-helper <verb> <args…>` (the pkexec one-shot, the argv
  contract below), `katacomb-vpn-helper --version`, and the hidden
  `katacomb-vpn-helper _tun2socks …` (the embedded tun2socks engine, which `tun-up`
  self-execs detached; every engine field is hardcoded except `-proxy`, and the
  engine's own flag parser and `TUNPreUp`/`TUNPostUp` shell hooks are never reached),
  and the hidden `katacomb-vpn-helper _amneziawg <config>` (the embedded AmneziaWG
  userspace device — `amneziawg-go` at the commit the Sentinel nodes pin — which
  `awg-up` self-execs detached; it reads the root-owned `/run/katacomb-vpn/sntl0.conf`,
  translates the wg(8) INI to the WireGuard UAPI itself and never opens a UAPI socket).
  An unknown verb prints the usage line and exits 1.
- Helper verbs: `up <config>`, `down`, `awg-up <config> <bindir>` (`<bindir>` is accepted and IGNORED since the AmneziaWG device is embedded — the same convention as `tun-up`'s `<bin>`; the app passes `-`), `awg-down`, `ovpn-up <config>`, `ovpn-down`, `tun-up <bin> <socks> <remote> <gw> <iface> [bypass]` (`<bin>` is accepted and IGNORED since the engine is embedded; the slot stays so old and new apps share one argv contract, and the app passes `-`), `tun-down`, `killswitch-on <iface> <host> [dns] [lan-sharing]`, `killswitch-off`, `dns-set <ip>`, `dns-restore`
- WireGuard/AmneziaWG interface: `sntl0`. tun2socks: `sntl-tun`. OpenVPN: `sntl-ovpn`.

### Privileged daemon (deb) vs. pkexec fallback (AppImage/dev)

The `.deb` installs a **persistent root daemon** (systemd `katacomb-vpn-daemon`, which
is `katacomb-vpn-helper daemon`) so connect/disconnect **never prompt for a password**.
The GUI (as the user) sends JSON ops over a Unix socket at
`/run/katacomb-vpn/daemon.sock`, owned `root:katacomb-vpn` **mode 0660** — members of
the group the postinst creates, not every local user (the 0666 world-accessible
fallback is dev-only, for when `getent group katacomb-vpn` finds nothing). Group
membership only applies to **new login sessions**, so a fresh `.deb` install needs one
log-out/log-in before the password-free path works — until then the GUI can't open the
socket and silently falls back to `pkexec`. The AppImage and `npm run dev` have no
daemon, so they fall back to the per-op `pkexec` one-shot (one cached prompt);
`npm run dev` builds the helper (`predev`) and the existing "VPN Helper Setup" dialog
installs it. Daemon mode by hand: `sudo /usr/local/bin/katacomb-vpn-helper daemon`.

- **`daemon/` is the whole root side**: one Go module whose only dependency is the
  tun2socks engine (`go.sum` + the checksum DB are the pin; no `vendor/`).
  `internal/ops` implements the twelve verbs natively and is **THE trust boundary** —
  both doors (the unauthenticated socket, the polkit-authenticated argv) end in the same
  `ops` call and every argument is validated there again, whatever the client checked.
  `internal/guard` is the root-side port of `config-guard.ts`'s allow-lists; the two are
  pinned to the same accept/reject sets by ONE fixture corpus
  (`daemon/internal/guard/testdata/corpus/`, read by `guard_test.go` and by
  `src/main/config-guard-corpus.test.ts`) — change a rule on one side and the other
  side's test goes red. `internal/protocol` + `internal/server` are daemon mode
  (newline-delimited JSON, 256 KiB cap, one mutex for state-changing ops with `status`
  exempt, 60 s per op); `internal/oneshot` is the argv contract. `daemon-protocol.ts`
  and `daemon-client.ts` are unchanged: the JSON shapes, op names and every `fail()`
  string are byte-compatible. **The two sides are pinned by a shared corpus**
  (`daemon/internal/protocol/testdata/corpus/protocol.json`, read by
  `protocol/corpus_test.go`, `server/corpus_test.go` and
  `src/main/daemon-protocol-corpus.test.ts`) — the same arrangement the guard corpus
  has always had, which the "byte for byte" claim previously lacked.
  **`protocol_version` now reports `{version, ops}` and IS called.** The version
  integer alone could never detect the skew that actually happens, because adding an
  op is deliberately not a version bump (`amneziawg_*` and `openvpn_*` were both
  additive) — so a daemon left running across an upgrade was found by `unknown op`
  from the bring-up, which for those two protocols is AFTER the session is paid for.
  `daemonMissingOp()` asks the op list in `preflightConnect` instead, and returns
  false whenever the answer is uncertain (no daemon, old daemon, failed probe), so it
  can only ever add a refusal we are sure of. `ops` is additive on the wire and the
  `unknown op` match stays as the fallback for a daemon too old to answer.
- **The exact command lines are pinned by golden transcripts**
  (`daemon/internal/ops/testdata/transcripts/`), captured from the ORIGINAL bash helper
  by `scripts/capture-helper-transcripts.sh` in a `debian:bookworm` container with every
  tool shimmed, and replayed by `transcript_test.go` against a recording Env that answers
  the queries the same way. Kill-switch rule order, tun2socks routes, openvpn's argv
  after `--config`, `cleanup_wg_rules`' scoping, every state file's bytes: a diff there
  is a bug or one of the deviations below. Regenerate only by hand, like the wire corpus
  `node-handshake.test.ts` keeps; the script reads the bash helper back from git history.
- **Deliberate deviations from the bash helper**, each small and each tested: daemon
  mode refuses euid ≠ 0; the socket is bound under `umask 077`; `null` / non-object /
  non-numeric-id requests get `{"id":0,"ok":false,"error":"invalid request"}` instead of
  killing the daemon (any group member could bounce it with `null\n`); the pid-less
  `tun-down` fallback is a `/proc` scan that signals only a process whose executable
  IS this helper, whose argv[1] is `_tun2socks` and whose argv carries `tun://sntl-tun`
  as a WHOLE entry (never `pkill -f`); **one validation layer for both modes** — the DNS allow-list
  applies to the pkexec one-shot too, so an admin-authenticated user cannot point every
  lookup at their resolver (the SHA pins used to sit here as well; they went with the
  vendored binaries root no longer runs, and `binary-integrity.ts` is now the only pin
  table, for the user-run cores);
  **one-shot configs are read ONCE**, via `O_NOFOLLOW` + `fstat` (regular file, owned by
  `PKEXEC_UID` when set, ≤ 256 KiB), and the tool is handed the root-owned
  `/run/katacomb-vpn/{sntl0,openvpn}.conf` copy, never the caller's path (the bash
  helper validated the caller's path and let wg-quick re-open it — a TOCTOU, and with a
  validator that echoed the line, a symlink to `/etc/shadow` was a root file-read
  oracle); **guard errors carry a line number and a reason word, never content**;
  children get a FIXED `PATH=/usr/sbin:/usr/bin:/sbin:/bin`; every state-changing verb takes `flock(/run/katacomb-vpn/.lock)` in
  BOTH modes (the daemon's mutex cannot see postrm's one-shot teardown or a pkexec
  fallback racing it); a timeout SIGTERMs the child and detached children are reaped by
  a goroutine; `status` and the link polls read `/sys/class/net/<iface>` instead of
  exec'ing `ip link show`. **`down` is now scoped to `sntl0`**: it used to delete every
  wireguard-type link, which was wrong because `detectOtherVpn` is a warn-with-override
  and not a gate, so a user really can connect with Mullvad or IVPN up — and our
  disconnect deleted their tunnel too, as root. `cleanupWgRules` keeps its own scoping
  (it repairs nothing while any wireguard link survives), and `wireguard_scope_test.go`
  pins both halves; no golden transcript covered this, because all of them were
  captured on a machine with only `sntl0`. **`bypassRoutes` are capped**
  (`MaxBypassRoutes`, refused above it rather than truncated) and the count of dropped
  entries is warned about rather than silently swallowed — the count only, never the
  content, per the guard rule that a refusal names a reason. Value-checking moved OUT
  of `dispatch` into `ops`: filtering in both meant `ops`, the trust boundary, never
  saw a rejected entry and so could not report one.
- **The unit keeps `/run/katacomb-vpn` across restarts** (`RuntimeDirectoryPreserve=restart`).
  postinstall runs `systemctl restart` on every upgrade, and without it every upgrade
  wiped `tun.state`/`openvpn.pid`, so the next `tun-down` found no pid and no remote
  host and left the `/32` and bypass routes behind. `KillMode` is untouched: an upgrade
  while connected still SIGTERMs the daemon's detached children (tun2socks,
  `openvpn --daemon`, the embedded AmneziaWG device), so only kernel WireGuard survives one —
  pre-existing, and a separate decision.
- **Install the helper through a temp name + `mv -f`** (postinstall and
  `ensurePolkitSetup`'s pkexec script): the daemon now runs FROM
  `/usr/local/bin/katacomb-vpn-helper`, and `cp` onto a running executable fails with
  `ETXTBSY`, which would abort every upgrade's postinst and leave the old daemon running.
  `ensurePolkitSetup` compares bundled and installed helper with `Buffer.equals` (it is a
  binary), which only stays quiet across dev rebuilds because `build-daemon.sh` builds
  reproducibly (`-trimpath -buildid=`, no VCS stamp): building the same tree twice gives
  the same bytes. It runs on every start, daemon or not (it used to be skipped when the
  daemon socket existed): a dev rebuild on a machine with the deb's daemon otherwise
  leaves the daemon on the OLD binary, which accepts the app's ops but validates configs
  with the old allow-lists and refuses as root, after the session is paid for (seen
  2026-09-18 with the AmneziaWG 3.1 keys). Its pkexec script ends with
  `systemctl try-restart katacomb-vpn-daemon.service`, a no-op where no unit exists.
- **`scripts/build-daemon.sh` fails loudly**: it asserts `go version` equals go.mod's
  `toolchain`, runs `go vet` + `go mod verify`, and asserts the output is statically
  linked (`CGO_ENABLED=0`) — because electron-builder only WARNS on a missing
  extraResources source, and a silently absent helper would ship as a deb whose unit
  points at nothing. CI sets Go up from `daemon/go.mod` and runs it before `npm test`.
- `daemon-client.ts` (`isDaemonAvailable`/`daemonRequest`) + `privileged.ts`
  (`runPrivileged` routes to the daemon if its socket exists, else `pkexec`).
  The privileged call tree (`vpn-manager`, `kill-switch`, `ipc-handlers`) is
  **async** because of the socket round-trip — and the `pkexec` fallback must stay
  async too. It was `execFileSync`, which blocks the Electron main process for the
  whole call, and on that path the call is a polkit dialog: nothing in main runs
  until the user answers it or the 60 s timeout fires (measured: zero event-loop
  ticks over a bare `sleep 2`). Live symptom, 2026-08-16: Disconnect froze the
  entire app, then reported the kill switch could not be turned off, leaving no
  internet and no way to retry. Never make a privileged call synchronous.
- Packaging: `postinstall.sh` installs the helper, policy and unit, then enables and
  restarts the unit. The `/opt/katacomb-vpn` symlink only ever gave the old Electron-run
  daemon a space-free `ExecStart`; it is gone since 1.9.0, the postinst removes a stale
  one on upgrade, and `postrm.sh` keeps its `rm -f` one more release. `postrm.sh` tears
  down any tunnel through the helper's one-shot verbs, then removes everything. Verify
  packaging by building + extracting the deb (`dpkg-deb -x`), not just by reading
  config, and with `scripts/verify-deb-containers.sh` (the five supported images:
  install, `ldd`, launch, `--version`, static, the daemon over its socket, the usage line).
