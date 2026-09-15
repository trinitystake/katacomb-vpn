import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, createPrivateKey } from 'node:crypto'
import { stringToPath } from '@cosmjs/crypto'
import { privKeyFromMnemonic, V2Ray, Wireguard } from '@sentinel-official/sentinel-js-sdk'
import { derivePrivKey, generateWireguardKeypair, generateProxyUuid, uuidToBytes } from './chain-keys.ts'

// These replaced SDK helpers that sign real transactions and real node
// handshakes, so "looks equivalent" is not good enough: each one is asserted
// byte-identical to what the SDK produced. Same argument node-handshake.test.ts
// makes for the handshake POST — the SDK stays a devDependency so this oracle
// keeps working.

const MNEMONICS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
]

test('derivePrivKey is byte-identical to the SDK across accounts', async () => {
  for (const mnemonic of MNEMONICS) {
    for (const account of [0, 1, 5, 100]) {
      const hdPath = stringToPath(`m/44'/118'/0'/0/${account}`)
      const ours = await derivePrivKey(mnemonic, hdPath)
      const theirs = await privKeyFromMnemonic({ mnemonic, hdPath })
      assert.deepEqual(
        Buffer.from(ours).toString('hex'),
        Buffer.from(theirs).toString('hex'),
        `mnemonic ${mnemonic.slice(0, 12)}… account ${account}`,
      )
      assert.equal(ours.length, 32)
    }
  }
})

test('derivePrivKey matches the SDK on the sentinel hub path too', async () => {
  const hdPath = stringToPath("m/44'/118'/0'/0/0")
  const ours = await derivePrivKey(MNEMONICS[0], hdPath)
  const theirs = await privKeyFromMnemonic({ mnemonic: MNEMONICS[0], hdPath })
  assert.deepEqual(Buffer.from(ours), Buffer.from(theirs))
})

test('generateWireguardKeypair emits raw 32-byte x25519 keys, base64, like the SDK', () => {
  // The SDK's own output is the shape reference: same encodings, same lengths.
  const sdk = new Wireguard()
  const ours = generateWireguardKeypair()
  for (const [label, k] of [['public', ours.publicKey], ['private', ours.privateKey]] as const) {
    assert.equal(Buffer.from(k, 'base64').length, 32, `${label} key must be 32 raw bytes`)
    assert.match(k, /^[A-Za-z0-9+/]+=*$/, `${label} key must be base64`)
  }
  assert.equal(Buffer.from(ours.publicKey, 'base64').length, Buffer.from(sdk.publicKey, 'base64').length)
  assert.equal(Buffer.from(ours.privateKey, 'base64').length, Buffer.from(sdk.privateKey, 'base64').length)
})

test('the generated public key really is the private key\'s x25519 public key', () => {
  // Independent of the SDK: rebuild the public key from the private one through
  // node:crypto and compare. A wrong DER offset would still produce 32 base64
  // bytes and a tunnel that never handshakes, which is the failure this catches.
  const { publicKey, privateKey } = generateWireguardKeypair()
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420', 'hex'), // PKCS#8 x25519 prefix
    Buffer.from(privateKey, 'base64'),
  ])
  const derived = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }))
    .export({ format: 'der', type: 'spki' })
    .subarray(12)
  assert.equal(Buffer.from(publicKey, 'base64').toString('hex'), derived.toString('hex'))
})

test('keypairs are fresh every call', () => {
  const a = generateWireguardKeypair()
  const b = generateWireguardKeypair()
  assert.notEqual(a.privateKey, b.privateKey)
  assert.notEqual(a.publicKey, b.publicKey)
})

test('uuidToBytes is byte-identical to the SDK V2Ray.getKey()', () => {
  // The SDK mints its own uuid internally, so feed its uuid to our converter and
  // assert the arrays match: that is the piece the node field actually parses.
  for (let i = 0; i < 20; i++) {
    const sdk = new V2Ray()
    // @ts-expect-error -- `uuid` is the SDK's own field, untyped in its .d.ts
    const theirUuid = sdk.uuid as string
    assert.deepEqual(uuidToBytes(theirUuid), sdk.getKey())
  }
})

test('generateProxyUuid produces a v4 uuid that round-trips to 16 bytes', () => {
  for (let i = 0; i < 20; i++) {
    const uuid = generateProxyUuid()
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const bytes = uuidToBytes(uuid)
    assert.equal(bytes.length, 16)
    assert.ok(bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
  }
})
