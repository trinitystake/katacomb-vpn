import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches render-time errors so a single bad IPC payload or context-misuse bug
 * can't white-screen the whole VPN client (finding L4). "Try again" clears the
 * error and re-renders — recovers from transient failures.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] Uncaught error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="h-screen flex items-center justify-center bg-bg-primary text-text-primary">
          <div className="max-w-md text-center space-y-4 p-6">
            <h1 className="text-lg font-semibold text-danger">Something went wrong</h1>
            <p className="text-sm text-text-secondary break-words">{this.state.error.message}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 rounded-sm bg-accent text-bg-primary text-sm font-medium hover:bg-accent-hover"
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
