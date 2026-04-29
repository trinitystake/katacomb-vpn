import { useState, useEffect, useCallback, createContext, useContext } from 'react'

interface ToastMessage {
  id: number
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
}

interface ToastContextType {
  toast: (type: ToastMessage['type'], message: string) => void
}

const ToastContext = createContext<ToastContextType>({
  toast: () => {},
})

export function useToast() {
  return useContext(ToastContext)
}

let nextId = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([])

  const toast = useCallback((type: ToastMessage['type'], message: string) => {
    const id = nextId++
    setMessages((prev) => [...prev, { id, type, message }])
  }, [])

  const dismiss = useCallback((id: number) => {
    setMessages((prev) => prev.filter((m) => m.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] space-y-2 max-w-sm">
        {messages.map((msg) => (
          <ToastItem key={msg.id} message={msg} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({
  message,
  onDismiss,
}: {
  message: ToastMessage
  onDismiss: (id: number) => void
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(message.id), 5000)
    return () => clearTimeout(timer)
  }, [message.id, onDismiss])

  const colorMap = {
    success: 'border-success text-success',
    error: 'border-danger text-danger',
    warning: 'border-warning text-warning',
    info: 'border-info text-info',
  }

  return (
    <div
      className={`bg-bg-secondary border ${colorMap[message.type]} px-4 py-3 text-sm rounded-md shadow-lg flex items-start gap-2 animate-fade-in`}
    >
      <span className="flex-1 break-words">{message.message}</span>
      <button
        onClick={() => onDismiss(message.id)}
        className="text-text-secondary hover:text-text-primary shrink-0"
      >
        ×
      </button>
    </div>
  )
}
