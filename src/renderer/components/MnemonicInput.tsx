import { useState } from 'react'
import englishWordlist from 'bip39/src/wordlists/english.json'

const wordSet = new Set<string>(englishWordlist)

interface Props {
  onImport: (mnemonic: string) => Promise<void>
}

type Mode = 'choose' | 'import' | 'create'

export default function MnemonicInput({ onImport }: Props) {
  const [mode, setMode] = useState<Mode>('choose')
  const [mnemonic, setMnemonic] = useState('')
  const [generatedMnemonic, setGeneratedMnemonic] = useState('')
  const [wordCount, setWordCount] = useState<12 | 24>(12)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  function validateMnemonic(value: string): string | null {
    const trimmed = value.trim()
    const words = trimmed.split(/\s+/)
    if (words.length !== 12 && words.length !== 24) {
      return 'Mnemonic must be 12 or 24 words'
    }
    const invalid = words.filter((w) => !wordSet.has(w))
    if (invalid.length > 0) {
      return `Invalid word${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`
    }
    return null
  }

  async function handleImportSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const err = validateMnemonic(mnemonic)
    if (err) { setError(err); return }
    setLoading(true)
    try {
      await onImport(mnemonic.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import wallet')
    } finally {
      setLoading(false)
    }
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
      await onImport(generatedMnemonic)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create wallet')
    } finally {
      setLoading(false)
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(generatedMnemonic)
  }

  function handleBack() {
    setMode('choose')
    setMnemonic('')
    setGeneratedMnemonic('')
    setError('')
    setConfirmed(false)
  }

  // --- Choose screen ---
  if (mode === 'choose') {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="w-full max-w-xl space-y-8">
          <div className="space-y-3">
            <h1 className="text-accent font-semibold text-2xl">
              Sentinel dVPN
            </h1>
            <p className="text-text-secondary text-sm leading-relaxed">
              Create a new wallet or import an existing one to connect to the decentralized VPN network.
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
              BIP-39 Mnemonic
            </label>
            <textarea
              value={mnemonic}
              onChange={(e) => setMnemonic(e.target.value)}
              placeholder="Enter your 12 or 24 word mnemonic phrase..."
              rows={4}
              className="w-full bg-bg-tertiary border border-border p-4 font-mono text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus rounded-md resize-none"
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            {error && (
              <p className="text-danger text-sm">{error}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || !mnemonic.trim()}
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
                Word Count
              </label>
              <div className="flex gap-3">
                <button
                  onClick={() => setWordCount(12)}
                  className={`flex-1 py-2 px-4 text-sm border transition-colors rounded-md ${
                    wordCount === 12
                      ? 'bg-accent border-accent text-white'
                      : 'border-border text-text-secondary hover:border-text-secondary'
                  }`}
                >
                  12 words
                </button>
                <button
                  onClick={() => setWordCount(24)}
                  className={`flex-1 py-2 px-4 text-sm border transition-colors rounded-md ${
                    wordCount === 24
                      ? 'bg-accent border-accent text-white'
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
