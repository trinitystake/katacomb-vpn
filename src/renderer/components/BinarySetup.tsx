import { useState, useEffect, useCallback } from 'react'
import type { BinaryStatus } from '../types'

const INSTALL_COMMANDS: Record<string, { label: string; command: string }[]> = {
  wireguard: [
    { label: 'Debian/Ubuntu', command: 'sudo apt install wireguard-tools' },
    { label: 'Fedora', command: 'sudo dnf install wireguard-tools' },
    { label: 'Arch', command: 'sudo pacman -S wireguard-tools' },
  ],
  v2ray: [
    { label: 'Official script', command: 'bash <(curl -L https://raw.githubusercontent.com/v2fly/fhs-install-v2ray/master/install-release.sh)' },
  ],
  tun2socks: [
    { label: 'Debian/Ubuntu', command: 'sudo apt install tun2socks' },
    { label: 'Arch (AUR)', command: 'yay -S tun2socks-bin' },
  ],
}

interface Props {
  onDismiss: () => void
}

export default function BinarySetup({ onDismiss }: Props) {
  const [status, setStatus] = useState<BinaryStatus | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const check = useCallback(async () => {
    try {
      const s = await window.api.binaryCheck()
      setStatus(s)
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    check()
  }, [check])

  function copyCommand(cmd: string) {
    navigator.clipboard.writeText(cmd)
    setCopied(cmd)
    setTimeout(() => setCopied(null), 2000)
  }

  if (!status) return null

  const allOk = status.wireguard && status.v2ray && status.tun2socks
  if (allOk) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-border w-full max-w-lg mx-4 max-h-[80vh] flex flex-col rounded-lg shadow-overlay">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-text-primary text-sm font-semibold">Binary Setup</h2>
          <button onClick={onDismiss} className="text-text-secondary hover:text-text-primary text-sm transition-colors">
            Dismiss
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <p className="text-text-secondary text-sm">
            Some VPN binaries are missing from your system. Install them to enable full functionality.
          </p>

          {([
            ['wireguard', 'WireGuard (wg-quick)', status.wireguard],
            ['v2ray', 'V2Ray', status.v2ray],
            ['tun2socks', 'tun2socks', status.tun2socks],
          ] as const).map(([key, label, ok]) => (
            <div key={key} className={`border px-4 py-3 space-y-2 rounded-md ${ok ? 'border-success bg-success-subtle' : 'border-danger bg-danger-subtle'}`}>
              <div className="flex items-center justify-between">
                <span className="text-text-primary text-sm">{label}</span>
                <span className={`text-xs font-medium ${ok ? 'text-success' : 'text-danger'}`}>
                  {ok ? 'Available' : 'Missing'}
                </span>
              </div>
              {!ok && INSTALL_COMMANDS[key] && (
                <div className="space-y-1.5">
                  {INSTALL_COMMANDS[key].map((cmd) => (
                    <div key={cmd.command} className="flex items-center gap-2">
                      <span className="text-text-secondary text-xs shrink-0">{cmd.label}:</span>
                      <code className="text-text-primary text-xs font-mono flex-1 bg-bg-tertiary px-2 py-1 border border-border truncate rounded-sm">
                        {cmd.command}
                      </code>
                      <button
                        onClick={() => copyCommand(cmd.command)}
                        className="text-text-secondary hover:text-accent text-xs shrink-0 transition-colors"
                      >
                        {copied === cmd.command ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          <button
            onClick={check}
            className="btn btn-primary text-sm w-full"
          >
            Recheck
          </button>
        </div>
      </div>
    </div>
  )
}
