/**
 * Just enough OpenPGP (RFC 4880) to pin a vendor's signing key before root installs it: undo the
 * ASCII armor, and name the primary key(s) inside by their v4 fingerprint.
 *
 * Why not `gpg --dearmor`: GnuPG is not installed by default on a minimal Debian, which is exactly
 * why Docker's own instructions ship the key as `.asc`. Doing it here also means the privileged
 * executor never pipes downloaded bytes into another program, and the fingerprint check needs no
 * keyring. The output is byte-for-byte what `gpg --dearmor` writes (the tests compare against it).
 *
 * This is not a signature verifier and does not try to be one. `apt` and `dnf` verify packages
 * against the key; this module only makes sure the key is the one the vendor documents.
 */

import { createHash } from 'node:crypto'
import { AtomicCoreError } from '../../contracts/index.js'

/** A downloaded key that is not what a vendor key must be: remote metadata the core refuses. */
const keyError = (message: string): AtomicCoreError =>
  new AtomicCoreError('MANAGED_METADATA_INVALID', message)

const BEGIN = '-----BEGIN PGP PUBLIC KEY BLOCK-----'
const END = '-----END PGP PUBLIC KEY BLOCK-----'
const BASE64_LINE = /^[A-Za-z0-9+/]*={0,2}$/

/** CRC-24 from RFC 4880 §6.1, the armor checksum. */
function crc24(bytes: Uint8Array): number {
  let crc = 0xb704ce
  for (const byte of bytes) {
    crc ^= byte << 16
    for (let bit = 0; bit < 8; bit++) {
      crc <<= 1
      if (crc & 0x1000000) crc ^= 0x1864cfb
    }
  }
  return crc & 0xffffff
}

/**
 * The binary key inside one ASCII-armored public key block. Anything else — an HTML error page, a
 * private key, two blocks, a damaged checksum — is refused rather than written to a keyring.
 */
export function dearmorPublicKey(text: string): Uint8Array {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const begin = lines.findIndex((line) => line.trim() === BEGIN)
  const end = lines.findIndex((line) => line.trim() === END)
  if (begin === -1 || end === -1 || end < begin) throw keyError('not an ASCII-armored public key block')
  if (lines.filter((line) => line.trim() === BEGIN).length !== 1)
    throw keyError('more than one public key block')

  // Armor headers ("Version: ...", "Comment: ...") run up to the first blank line.
  let index = begin + 1
  while (index < end && lines[index]!.trim() !== '') {
    if (!/^[A-Za-z][A-Za-z0-9-]*: /.test(lines[index]!)) break
    index += 1
  }
  if (index < end && lines[index]!.trim() === '') index += 1

  let body = ''
  let checksum: string | null = null
  for (; index < end; index++) {
    const line = lines[index]!.trim()
    if (line === '') continue
    if (line.startsWith('=') && line.length === 5) {
      checksum = line.slice(1)
      continue
    }
    if (checksum !== null || !BASE64_LINE.test(line)) throw keyError('the armored key body is malformed')
    body += line
  }
  if (body === '') throw keyError('the armored key block is empty')
  const bytes = Uint8Array.from(Buffer.from(body, 'base64'))
  // `Buffer.from` skips what it cannot decode; a round trip proves nothing was skipped.
  if (Buffer.from(bytes).toString('base64').replace(/=+$/, '') !== body.replace(/=+$/, ''))
    throw keyError('the armored key body is not valid base64')
  if (checksum !== null) {
    const expected = Buffer.from(checksum, 'base64')
    const actual = crc24(bytes)
    if (expected.length !== 3 || expected.readUIntBE(0, 3) !== actual)
      throw keyError('the armor checksum does not match the key body')
  }
  return bytes
}

interface Packet {
  tag: number
  body: Uint8Array
}

function readPackets(bytes: Uint8Array): Packet[] {
  const packets: Packet[] = []
  let offset = 0
  const need = (count: number): void => {
    if (offset + count > bytes.length) throw keyError('the key data is truncated')
  }
  while (offset < bytes.length) {
    const header = bytes[offset]!
    offset += 1
    if ((header & 0x80) === 0) throw keyError('not an OpenPGP packet header')
    let tag: number
    let length: number
    if (header & 0x40) {
      tag = header & 0x3f
      need(1)
      const first = bytes[offset]!
      if (first < 192) {
        length = first
        offset += 1
      } else if (first < 224) {
        need(2)
        length = ((first - 192) << 8) + bytes[offset + 1]! + 192
        offset += 2
      } else if (first === 255) {
        need(5)
        length = Buffer.from(bytes.subarray(offset + 1, offset + 5)).readUInt32BE(0)
        offset += 5
      } else {
        throw keyError('partial body lengths are not valid in a key')
      }
    } else {
      tag = (header >> 2) & 0x0f
      const lengthType = header & 0x03
      if (lengthType === 3) throw keyError('an indeterminate packet length is not valid in a key')
      const size = [1, 2, 4][lengthType]!
      need(size)
      length = Buffer.from(bytes.subarray(offset, offset + size)).readUIntBE(0, size)
      offset += size
    }
    need(length)
    packets.push({ tag, body: bytes.subarray(offset, offset + length) })
    offset += length
  }
  return packets
}

const PUBLIC_KEY_TAG = 6

/**
 * Uppercase hex v4 fingerprints of every primary key (not subkey) in binary key data, in order.
 * The fingerprint is SHA-1 over `0x99`, the two-octet body length and the public-key packet body
 * (RFC 4880 §12.2) — the same 40 hex digits vendors publish and `gpg --show-keys` prints.
 */
export function primaryKeyFingerprints(bytes: Uint8Array): string[] {
  const fingerprints: string[] = []
  for (const packet of readPackets(bytes)) {
    if (packet.tag !== PUBLIC_KEY_TAG) continue
    const version = packet.body[0]
    if (version !== 4) throw keyError(`a version ${String(version)} public key cannot be pinned here`)
    const prefix = Buffer.from([0x99, (packet.body.length >> 8) & 0xff, packet.body.length & 0xff])
    fingerprints.push(createHash('sha1').update(prefix).update(packet.body).digest('hex').toUpperCase())
  }
  return fingerprints
}
