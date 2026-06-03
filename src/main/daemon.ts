// Entry point for the root daemon (systemd ExecStart target, run via
// ELECTRON_RUN_AS_NODE). All logic lives in daemon-core (import-safe for tests).
import { startDaemon } from './daemon-core'

startDaemon()
