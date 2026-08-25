import AppLogo from './AppLogo'

const GITHUB_URL = 'https://github.com/trinitystake/katacomb-vpn'

/**
 * The one About surface: opened by the status bar's version chip and by the
 * tray's "About" item (via ABOUT_SHOW). The GitHub anchor opens in the system
 * browser through main's setWindowOpenHandler, like every external link here.
 */
export default function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-secondary border border-border w-full max-w-xs mx-4 p-6 rounded-lg shadow-overlay text-center space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <AppLogo size={56} className="mx-auto" />

        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-text-primary">Katacomb VPN</h2>
          <p className="text-sm text-text-secondary">Version {__APP_VERSION__}</p>
        </div>

        <p className="text-sm text-text-secondary">Decentralized VPN client.</p>

        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="block text-sm text-accent hover:underline"
        >
          GitHub repository
        </a>

        <button className="btn btn-secondary w-full" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
