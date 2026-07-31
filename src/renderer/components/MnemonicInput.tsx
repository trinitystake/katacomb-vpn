import { useState, useRef, useEffect, useMemo } from 'react'
import { checkMnemonic } from '../../shared/mnemonic'
import { parseWalletExists } from '../../shared/wallet-errors'

interface Props {
  onImport: (mnemonic: string, name?: string) => Promise<void>
  /** Present only when wallets are already stored — returns to the picker. */
  onBackToWallets?: () => void
  /** Open the wallet that already holds the entered seed's address. */
  onUseExisting: (walletId: string) => Promise<void>
}

type Mode = 'choose' | 'import' | 'create'

export default function MnemonicInput({ onImport, onBackToWallets, onUseExisting }: Props) {
  const [mode, setMode] = useState<Mode>('choose')
  // Set when the entered seed is already stored: nothing was created, so offer
  // that wallet instead of leaving the user at a dead end.
  const [duplicate, setDuplicate] = useState<{ id: string; message: string } | null>(null)
  const [mnemonic, setMnemonic] = useState('')
  const [walletName, setWalletName] = useState('')
  const [generatedMnemonic, setGeneratedMnemonic] = useState('')
  const [wordCount, setWordCount] = useState<12 | 24>(12)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const copyClearTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (copyClearTimer.current !== null) window.clearTimeout(copyClearTimer.current)
  }, [])

  // Word list, word count and checksum, re-run on every keystroke.
  const check = useMemo(() => checkMnemonic(mnemonic), [mnemonic])

  async function handleImportSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setDuplicate(null)
    if (check.status !== 'valid') return
    setLoading(true)
    try {
      // The normalized phrase, not what was typed: it is the form the checksum
      // was verified against and the only one CosmJS accepts.
      await onImport(check.phrase, walletName.trim() || undefined)
    } catch (err) {
      handleCreateFailure(err, 'Failed to import wallet')
    } finally {
      setLoading(false)
    }
  }

  /** Shared by import and create: both go through addWalletEntry's uniqueness guard. */
  function handleCreateFailure(err: unknown, fallback: string) {
    const message = err instanceof Error ? err.message : fallback
    const existing = parseWalletExists(message)
    if (existing) {
      setDuplicate(existing)
      setError('')
      return
    }
    setError(message)
  }

  async function handleGenerate() {
    setError('')
    setLoading(true)
    try {
      const phrase = await window.api.walletGenerate(wordCount)
      setGeneratedMnemonic(phrase)
      setConfirmed(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate mnemonic')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmCreate() {
    setError('')
    setLoading(true)
    try {
      await onImport(generatedMnemonic, walletName.trim() || undefined)
    } catch (err) {
      handleCreateFailure(err, 'Failed to create wallet')
    } finally {
      setLoading(false)
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(generatedMnemonic)
    // Don't let the seed linger on the clipboard — clear it after 30s (finding M5).
    if (copyClearTimer.current !== null) window.clearTimeout(copyClearTimer.current)
    copyClearTimer.current = window.setTimeout(() => {
      navigator.clipboard.writeText('').catch(() => {})
      copyClearTimer.current = null
    }, 30_000)
  }

  function handleBack() {
    setMode('choose')
    setMnemonic('')
    setWalletName('')
    setGeneratedMnemonic('')
    setError('')
    setDuplicate(null)
    setConfirmed(false)
  }

  /** Nothing was created — that seed is already on this device. */
  function duplicatePanel() {
    if (!duplicate) return null
    return (
      <div className="bg-warning-subtle border border-warning p-3 rounded-md space-y-2">
        <p className="text-warning text-sm">{duplicate.message}</p>
        <button
          type="button"
          onClick={() => onUseExisting(duplicate.id)}
          className="btn btn-secondary w-full"
        >
          Use that wallet
        </button>
      </div>
    )
  }

  // --- Choose screen ---
  if (mode === 'choose') {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="w-full max-w-xl space-y-8">
          <div className="space-y-3">
            {onBackToWallets && (
              <button
                type="button"
                onClick={onBackToWallets}
                className="text-text-secondary text-sm hover:text-accent transition-colors"
              >
                &larr; Back to my wallets
              </button>
            )}
            <h1 className="text-accent font-semibold text-2xl">
              Katacomb VPN
            </h1>
            <p className="text-text-secondary text-sm leading-relaxed">
              {onBackToWallets
                ? 'Add another wallet by creating a new one or importing an existing seed phrase.'
                : 'Create a new wallet or import an existing one to connect to the decentralized VPN network.'}
            </p>
          </div>

          <div className="space-y-3">
            <button
              onClick={() => setMode('create')}
              className="btn btn-primary w-full"
            >
              Create New Wallet
            </button>
            <button
              onClick={() => setMode('import')}
              className="btn btn-secondary w-full"
            >
              Import Existing Wallet
            </button>
          </div>

          <p className="text-text-tertiary text-xs text-center">
            Your mnemonic is encrypted at rest using your OS keyring.
            It never leaves this device.
          </p>
        </div>
      </div>
    )
  }

  // --- Import screen ---
  if (mode === 'import') {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <form onSubmit={handleImportSubmit} className="w-full max-w-xl space-y-6">
          <div className="space-y-2">
            <button
              type="button"
              onClick={handleBack}
              className="text-text-secondary text-sm hover:text-accent transition-colors"
            >
              &larr; Back
            </button>
            <h1 className="text-text-primary font-semibold text-2xl">
              Import Wallet
            </h1>
            <p className="text-text-secondary text-sm">
              Enter your BIP-39 mnemonic phrase.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-text-secondary text-sm font-medium block">
              Wallet Name <span className="text-text-tertiary font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={walletName}
              onChange={(e) => setWalletName(e.target.value)}
              placeholder="e.g. Cold Storage"
              maxLength={100}
              className="w-full bg-bg-tertiary border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus rounded-md"
              autoComplete="off"
            />
          </div>

          <div className="space-y-2">
            <label className="text-text-secondary text-sm font-medium block">
              BIP-39 Mnemonic
            </label>
            <textarea
              value={mnemonic}
              onChange={(e) => { setMnemonic(e.target.value); if (error) setError('') }}
              placeholder="Enter your 12 or 24 word mnemonic phrase..."
              rows={4}
              className={`w-full bg-bg-tertiary border p-4 font-mono text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none rounded-md resize-none ${
                check.status === 'invalid' ? 'border-danger' : 'border-border focus:border-border-focus'
              }`}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            {error ? (
              <p className="text-danger text-sm">{error}</p>
            ) : check.message ? (
              <p
                className={`text-sm ${
                  check.status === 'valid'
                    ? 'text-success'
                    : check.status === 'invalid'
                      ? 'text-danger'
                      : 'text-text-tertiary'
                }`}
              >
                {check.status === 'valid' ? '✓ ' : ''}{check.message}
              </p>
            ) : null}
          </div>

          {duplicatePanel()}

          <button
            type="submit"
            disabled={loading || check.status !== 'valid'}
            className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {loading ? 'Importing...' : 'Import Wallet'}
          </button>
        </form>
      </div>
    )
  }

  // --- Create screen ---
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="w-full max-w-xl space-y-6">
        <div className="space-y-2">
          <button
            type="button"
            onClick={handleBack}
            className="text-text-secondary text-sm hover:text-accent transition-colors"
          >
            &larr; Back
          </button>
          <h1 className="text-text-primary font-semibold text-2xl">
            Create Wallet
          </h1>
          <p className="text-text-secondary text-sm leading-relaxed">
            Generate a new BIP-39 mnemonic. Write it down and store it safely — this is the only way to recover your wallet.
          </p>
        </div>

        {!generatedMnemonic ? (
          <>
            <div className="space-y-2">
              <label className="text-text-secondary text-sm font-medium block">
                Wallet Name <span className="text-text-tertiary font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="e.g. Daily Driver"
                maxLength={100}
                className="w-full bg-bg-tertiary border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus rounded-md"
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <label className="text-text-secondary text-sm font-medium block">
                Word Count
              </label>
              <div className="flex gap-3">
                <button
                  onClick={() => setWordCount(12)}
                  className={`flex-1 py-2 px-4 text-sm border transition-colors rounded-md ${
                    wordCount === 12
                      ? 'bg-accent border-accent text-text-on-accent'
                      : 'border-border text-text-secondary hover:border-text-secondary'
                  }`}
                >
                  12 words
                </button>
                <button
                  onClick={() => setWordCount(24)}
                  className={`flex-1 py-2 px-4 text-sm border transition-colors rounded-md ${
                    wordCount === 24
                      ? 'bg-accent border-accent text-text-on-accent'
                      : 'border-border text-text-secondary hover:border-text-secondary'
                  }`}
                >
                  24 words
                </button>
              </div>
            </div>

            {error && (
              <p className="text-danger text-sm">{error}</p>
            )}

            <button
              onClick={handleGenerate}
              disabled={loading}
              className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {loading ? 'Generating...' : 'Generate Mnemonic'}
            </button>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-text-secondary text-sm font-medium">
                  Your Mnemonic
                </label>
                <button
                  onClick={handleCopy}
                  className="text-text-secondary text-sm hover:text-accent transition-colors"
                >
                  Copy
                </button>
              </div>
              <div className="bg-bg-tertiary border border-border p-4 font-mono text-sm text-text-primary select-all leading-relaxed rounded-md">
                {generatedMnemonic.split(' ').map((word, i) => (
                  <span key={i}>
                    <span className="text-text-tertiary">{i + 1}.</span>{word}{' '}
                  </span>
                ))}
              </div>
            </div>

            <div className="bg-danger-subtle border border-danger p-3 rounded-md">
              <p className="text-danger text-sm">
                Write down these words in order and store them in a safe place. Anyone with this phrase can access your funds. You will not be shown this again.
              </p>
            </div>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              <span className="text-text-secondary text-sm">
                I have written down my mnemonic and stored it safely
              </span>
            </label>

            {error && (
              <p className="text-danger text-sm">{error}</p>
            )}

            {duplicatePanel()}

            <button
              onClick={handleConfirmCreate}
              disabled={loading || !confirmed}
              className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {loading ? 'Creating wallet...' : 'Create Wallet'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
