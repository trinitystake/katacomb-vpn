import type { ipcMain } from 'electron'

/**
 * The trust wrapper each handler group is registered through.
 *
 * ipc-handlers.ts owns the one `ipcMain.handle` call and the sender check around
 * it; groups take it as a parameter rather than importing `ipcMain` themselves,
 * so there stays exactly one door into the main process and no module can open
 * a second by accident.
 */
export type Handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) => void
