import { useEffect, useRef, useState } from 'react'
import { useTheme } from '../hooks/useTheme'

interface Props {
  data: string
  onClose: () => void
}

export default function QRCodeDisplay({ data, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [copied, setCopied] = useState(false)
  const { resolved } = useTheme()

  useEffect(() => {
    import('qrcode').then((QRCode) => {
      if (canvasRef.current) {
        const colors = resolved === 'dark'
          ? { dark: '#f1f5f9', light: '#1e293b' }
          : { dark: '#1e293b', light: '#ffffff' }
        QRCode.toCanvas(canvasRef.current, data, {
          width: 280,
          margin: 2,
          color: colors,
        })
      }
    }).catch(() => {
      // qrcode not available in renderer — show text fallback
    })
  }, [data, resolved])

  async function handleCopy() {
    await navigator.clipboard.writeText(data)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]" onClick={onClose}>
      <div
        className="bg-bg-secondary border border-border p-6 space-y-4 rounded-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-text-primary text-sm font-medium">
            WireGuard Config
          </h3>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-sm transition-colors">
            ×
          </button>
        </div>

        <div className="flex justify-center">
          <canvas ref={canvasRef} />
        </div>

        <pre className="bg-bg-tertiary border border-border p-3 text-xs font-mono text-text-secondary max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm">
          {data}
        </pre>

        <button onClick={handleCopy} className="btn btn-primary w-full text-sm">
          {copied ? 'Copied!' : 'Copy Config'}
        </button>
      </div>
    </div>
  )
}
