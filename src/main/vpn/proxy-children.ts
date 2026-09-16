import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readlinkSync } from 'fs'
import type { ChildProcess } from 'child_process'

/**
 * Reaping proxy cores that outlived the run which spawned them.
 *
 * The problem this solves: v2ray/xray/hysteria2 are spawned as ordinary children
 * (deliberately — tun2socks is the one thing that IS detached, because root owns
 * it), and Linux does not kill a child when its parent dies. A SIGKILLed or crashed
 * GUI therefore leaves the core running and holding 127.0.0.1:1080, and the next
 * connect on any of those three protocols spawns a core that cannot bind the port,
 * exits immediately, and surfaces as "process exited immediately after starting"
 * with nothing pointing at the cause.
 *
 * The orphan does NOT clean itself up. Measured against the bundled xray 2026-08-26:
 * parent killed, child reparented to PID 1, still listening 20s later. The plausible
 * escape — stdio is piped, so a write to the closed pipe should raise SIGPIPE — does
 * not happen, because at `loglevel: warning` an idle core writes nothing at all. So
 * survival is the normal case for exactly the tunnel a user is most likely to have
 * left idle, not a rare one.
 *
 * Not solvable by matching on process name: a user may run their own v2ray or xray,
 * and resolveV2RayBinary falls back to the system one, so the name can genuinely
 * belong to someone else. Hence a recorded pid plus the two-part identity check in
 * isRecordedProxyChild.
 *
 * Electron-free on purpose (the caller passes the userData path in), so the whole
 * mechanism is exercisable under the native test runner against real processes.
 * That is also why it has no relative imports and repeats fs-utils' temp-and-rename
 * inline: the native runner cannot resolve an extensionless sibling, which is why
 * every other unit-tested module in src/main (connect-decisions, config-guard,
 * multihop-config) is likewise import-free.
 */

export interface ProxyChildRecord {
  pid: number
  /** Resolved /proc/<pid>/exe target, as read at spawn time. */
  exe: string
  /** The config path we passed. Lives under the spawning run's SECURE_TMPDIR, i.e.
   *  a fresh mkdtemp per launch, so it is unique to the run that recorded it. */
  configFile: string
}

/**
 * Parse a records file. Every field is re-checked rather than trusted: this is our
 * own file, but a truncated write or a hand-edit must not put a stray value into
 * `pid` — the one field that later becomes the target of a signal.
 */
export function parseProxyChildRecords(raw: string): ProxyChildRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((r): r is ProxyChildRecord => {
    if (!r || typeof r !== 'object') return false
    const rec = r as Partial<ProxyChildRecord>
    return typeof rec.pid === 'number' && Number.isInteger(rec.pid) && rec.pid > 1
      && typeof rec.exe === 'string' && rec.exe.length > 0
      && typeof rec.configFile === 'string' && rec.configFile.length > 0
  })
}

export function readProxyChildRecords(statePath: string): ProxyChildRecord[] {
  if (!existsSync(statePath)) return []
  try {
    return parseProxyChildRecords(readFileSync(statePath, 'utf-8'))
  } catch {
    return []
  }
}

export function writeProxyChildRecords(statePath: string, records: ProxyChildRecord[]): void {
  try {
    if (records.length === 0) {
      if (existsSync(statePath)) unlinkSync(statePath)
      return
    }
    // Same temp-and-rename as fs-utils' writeFileAtomic, for the reason above. A
    // torn write is survivable regardless: it fails to parse, so the reap is skipped
    // and a stale core survives, which is exactly the behaviour without this file.
    const tmp = `${statePath}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 })
    renameSync(tmp, statePath)
  } catch { /* best-effort: losing the record costs a stale process, not correctness */ }
}

/**
 * Both halves must agree before we send a signal, because a pid recorded by an
 * earlier run may have been reused by an unrelated process since. `exe` alone is
 * not enough (the user may run the same binary); the config path is what makes it
 * decisive, since it sits under a per-launch mkdtemp directory that no other
 * program has a reason to reference.
 */
export function isRecordedProxyChild(rec: ProxyChildRecord): boolean {
  try {
    if (readlinkSync(`/proc/${rec.pid}/exe`) !== rec.exe) return false
    // /proc/<pid>/cmdline is NUL-separated, so this compares whole argv entries
    // rather than substrings.
    return readFileSync(`/proc/${rec.pid}/cmdline`, 'utf-8').split('\0').includes(rec.configFile)
  } catch {
    // Gone, or not ours to inspect. Either way, not something to kill.
    return false
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Record a freshly spawned core, and drop the record when it exits. Tracking on
 * spawn and untracking from the child's own 'exit' covers every way it can die
 * while we are alive, so the file is absent in the normal case and present only
 * after an exit path that never ran.
 */
export function trackProxyChildIn(statePath: string, child: ChildProcess, configFile: string): void {
  const pid = child.pid
  if (!pid) return
  let exe: string
  try {
    exe = readlinkSync(`/proc/${pid}/exe`)
  } catch {
    // No /proc entry means the child is already gone; nothing to reap later.
    return
  }
  const others = readProxyChildRecords(statePath).filter((r) => r.pid !== pid)
  writeProxyChildRecords(statePath, [...others, { pid, exe, configFile }])
  child.on('exit', () => {
    writeProxyChildRecords(statePath, readProxyChildRecords(statePath).filter((r) => r.pid !== pid))
  })
}

/**
 * Kill proxy cores left running by a previous run. Returns true if anything was
 * actually killed, so the caller can tell the user their tunnel was closed.
 *
 * Bounded by design: this runs during startup, so it must not stall launch. SIGTERM
 * first, and SIGKILL only for a core still alive after `graceMs`, because the whole
 * point is to free the port before the user's next connect needs it.
 */
export async function reapOrphanedProxyChildrenIn(statePath: string, graceMs = 1000): Promise<boolean> {
  const records = readProxyChildRecords(statePath)
  if (records.length === 0) return false

  const ours = records.filter(isRecordedProxyChild)
  // Anything unverifiable is dropped rather than retried: the pid is dead or now
  // belongs to someone else, and either way the record is spent.
  writeProxyChildRecords(statePath, [])
  if (ours.length === 0) return false

  for (const rec of ours) {
    console.log(`[startup] Proxy core ${rec.pid} outlived a previous run, stopping it`)
    try { process.kill(rec.pid, 'SIGTERM') } catch { /* raced us */ }
  }

  const deadline = Date.now() + graceMs
  let pending = ours.filter((r) => isPidAlive(r.pid))
  while (pending.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    pending = pending.filter((r) => isPidAlive(r.pid))
  }
  for (const rec of pending) {
    try { process.kill(rec.pid, 'SIGKILL') } catch { /* raced us */ }
  }
  return true
}
