// Key material derivation. Replaces the SDK helpers the app used to call for
// this, all of which were thin wrappers over @cosmjs/crypto or node:crypto:
//
//   privKeyFromMnemonic  -> derivePrivKey below (4 lines of CosmJS in the SDK)
//   new Wireguard()      -> generateWireguardKeypair (node:crypto x25519)
//   new V2Ray().getKey() -> generateProxyUuid / uuidToBytes (randomUUID + hex)
//
// Why not keep using the SDK's: its Wireguard and V2Ray classes are not keygen
// helpers, they are connection managers. Constructing one pulls axios, qrcode,
// find-free-ports and child_process into the main process, and the class can
// spawn `v2ray`, mkdtemp a config and print QR codes. The app wanted four bytes
// of key material and was loading all of that to get it.
//
// Electron-free and unit-tested under the native runner, so no relative imports
// (the same constraint tx-utils.ts and provider-msgs.ts document).

import { Bip39, EnglishMnemonic, Slip10, Slip10Curve, type HdPath } from '@cosmjs/crypto'
import { generateKeyPairSync, randomUUID } from 'node:crypto'

/**
 * Derive the secp256k1 private key for one BIP-44 path.
 *
 * `hdPath` is REQUIRED, unlike the SDK's version, which defaulted to account 0.
 * That default was a live footgun: for any other account index it silently
 * returned a key that did not match the address the session was bought with, so
 * node handshakes were signed by the wrong wallet. Making it required means the
 * mistake cannot be made rather than being commented against at each call site.
 */
export async function derivePrivKey(mnemonic: string, hdPath: HdPath): Promise<Uint8Array> {
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic), '')
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, hdPath)
  return privkey
}

export interface WireguardKeypair {
  /** base64, the form wg(8) writes in a config and the node expects. */
  publicKey: string
  privateKey: string
}

/**
 * A fresh WireGuard/AmneziaWG x25519 keypair.
 *
 * The subarray offsets strip DER wrappers to leave the raw 32-byte keys: SPKI
 * prefixes a public key with 12 bytes, PKCS#8 a private key with 16. Same
 * derivation the SDK did, so the bytes on the wire are unchanged.
 */
export function generateWireguardKeypair(): WireguardKeypair {
  const keys = generateKeyPairSync('x25519', {
    publicKeyEncoding: { format: 'der', type: 'spki' },
    privateKeyEncoding: { format: 'der', type: 'pkcs8' },
  })
  return {
    publicKey: keys.publicKey.subarray(12).toString('base64'),
    privateKey: keys.privateKey.subarray(16).toString('base64'),
  }
}

/** A fresh UUID for a VLESS/VMess peer, as a string. */
export function generateProxyUuid(): string {
  return randomUUID()
}

/**
 * A UUID as the 16-BYTE ARRAY form some node fields require.
 *
 * Which form to send is not a style choice and has cost a live HTTP 500: v2ray
 * and xray declare the peer field as v2fly `uuid.UUID` ([16]byte) and accept the
 * array; hysteria2 declares it as a Go `string` and rejects the array outright.
 * OpenVPN takes the array too. Use this only for the array protocols and send
 * the string form to hysteria2.
 */
export function uuidToBytes(uuid: string): number[] {
  return Array.from(Buffer.from(uuid.replace(/-/g, ''), 'hex'))
}
