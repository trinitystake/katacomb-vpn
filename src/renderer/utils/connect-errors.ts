import { DNS_PROVISION_FAILED } from '../../shared/error-markers'

/** Did the bring-up fail only because the host has no resolvconf? */
export function isDnsProvisionFailure(message: string): boolean {
  return message.startsWith(DNS_PROVISION_FAILED)
}

/** Strip the internal marker prefix — users should never see it. */
export function displayConnectError(message: string): string {
  return isDnsProvisionFailure(message)
    ? message.slice(DNS_PROVISION_FAILED.length).replace(/^:\s*/, '')
    : message
}
