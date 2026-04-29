interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

export default function Toggle({ checked, onChange, disabled }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-200 focus:outline-none disabled:opacity-40 ${
        checked
          ? 'bg-accent border-accent'
          : 'bg-bg-tertiary border-border'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform duration-200 ${
          checked
            ? 'translate-x-[17px] bg-white'
            : 'translate-x-[3px] bg-text-secondary'
        }`}
      />
    </button>
  )
}
