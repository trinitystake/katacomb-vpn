import type { ProviderDetailsInput } from '../../types'
import { PROVIDER_LIMITS, byteLength } from '../../../shared/provider-details'

/**
 * The four editable fields of a provider record, shared by registration and by
 * editing an existing provider.
 *
 * They are one component rather than two copies because the chain treats them as
 * one message: MsgRegisterProvider and MsgUpdateProviderDetails carry the exact
 * same four strings under the same limits, so a label or a cap that drifted
 * between the two screens would be a bug either way.
 */
export default function ProviderDetailsFields({ details, onChange, disabled }: {
  details: ProviderDetailsInput
  onChange: (next: ProviderDetailsInput) => void
  disabled?: boolean
}) {
  const set = (key: keyof ProviderDetailsInput) => (value: string) => onChange({ ...details, [key]: value })
  return (
    <div className="space-y-3">
      <Field label="Name" value={details.name} onChange={set('name')} disabled={disabled}
        cap={PROVIDER_LIMITS.name} placeholder="Shown next to your plans" />
      <Field label="Website" value={details.website} onChange={set('website')} disabled={disabled}
        cap={PROVIDER_LIMITS.website} placeholder="https://…" />
      <Field label="Identity" value={details.identity} onChange={set('identity')} disabled={disabled}
        cap={PROVIDER_LIMITS.identity} placeholder="Keybase identity (optional)" />
      <Field label="Description" value={details.description} onChange={set('description')} disabled={disabled}
        cap={PROVIDER_LIMITS.description} placeholder="Optional" />
    </div>
  )
}

/**
 * One labelled text input with a byte counter.
 *
 * The counter measures BYTES, not characters, because that is what the chain
 * caps: a name of 40 accented characters can be over the 64-byte limit while
 * looking well short of it, and the only other place that would surface is a
 * rejected transaction.
 */
export function Field({ label, value, placeholder, cap, disabled, onChange }: {
  label: string
  value: string
  placeholder?: string
  cap: number
  disabled?: boolean
  onChange: (v: string) => void
}) {
  const used = byteLength(value)
  const over = used > cap
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">{label}</span>
        {(used > cap * 0.75 || over) && (
          <span className={`text-[10px] font-mono ${over ? 'text-danger' : 'text-text-tertiary'}`}>
            {used}/{cap}
          </span>
        )}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full bg-bg-tertiary border text-text-primary text-sm px-3 py-2 rounded-sm focus:outline-none disabled:opacity-40 ${
          over ? 'border-danger' : 'border-border focus:border-border-focus'
        }`}
      />
    </label>
  )
}
