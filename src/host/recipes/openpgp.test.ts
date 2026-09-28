import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dearmorPublicKey, primaryKeyFingerprints } from './openpgp.js'

const keys = join(process.cwd(), 'test/fixtures/host-keys')
const read = (name: string): string => readFileSync(join(keys, name), 'utf8')
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * The vendors' real public keys, as served. Expected values are what GnuPG itself says:
 * `gpg --show-keys --with-fingerprint <file>` and `gpg --dearmor < <file> | shasum -a 256`.
 */
describe.each([
  [
    'docker-deb.asc',
    '9DC858229FC7DD38854AE2D88D81803C0EBFCD88',
    'a09e26b72228e330d55bf134b8eaca57365ef44bf70b8e27c5f55ea87a8b05e2',
  ],
  [
    'docker-rpm.asc',
    '060A61C51B558A7F742B77AAC52FEB6B621E9F35',
    '024ac82084faf8695cb5974e6c51b850c0bac9d1b5c362d557bb26a5cbf669bb',
  ],
  [
    'nvidia-container-toolkit.asc',
    'C95B321B61E88C1809C4F759DDCAE044F796ECB0',
    '425822bb25bfa7f5ce96e598a7bbd27db128649e4113017b3ff765b98b43b166',
  ],
])('%s', (file, fingerprint, dearmoredSha256) => {
  it('dearmors to exactly the bytes `gpg --dearmor` writes', () => {
    expect(sha256(dearmorPublicKey(read(file)))).toBe(dearmoredSha256)
  })

  it('names the same primary key fingerprint GnuPG shows', () => {
    expect(primaryKeyFingerprints(dearmorPublicKey(read(file)))).toEqual([fingerprint])
  })
})

describe('refusing what is not one well-formed public key block', () => {
  const docker = read('docker-deb.asc')

  it.each<[string, string]>([
    ['an empty body', ''],
    ['an HTML error page', '<html><body>404</body></html>'],
    ['a private key block', docker.replace(/PUBLIC KEY BLOCK/g, 'PRIVATE KEY BLOCK')],
    ['a block with no end line', docker.replace(/-----END PGP PUBLIC KEY BLOCK-----/, '')],
    ['a damaged checksum', docker.replace(/=0YYh/, '=AAAA')],
    ['base64 that does not decode cleanly', docker.replace(/mQINBFit/, 'mQ!NBFit')],
    ['two blocks glued together', `${docker}\n${docker}`],
  ])('%s', (_name, text) => {
    expect(() => dearmorPublicKey(text)).toThrow()
  })

  it('a changed key body is caught by the armor checksum', () => {
    expect(() => dearmorPublicKey(docker.replace('mQINBFit2ioB', 'mQINBFit2ioC'))).toThrow(/checksum/)
  })

  it('packets that are not a v4 public key yield no fingerprint to match', () => {
    // A lone user-id packet (new format, tag 13) has no primary key in it.
    const userId = Uint8Array.from([0xcd, 0x03, 0x61, 0x62, 0x63])
    expect(primaryKeyFingerprints(userId)).toEqual([])
    // A truncated packet is refused rather than read past its end.
    expect(() => primaryKeyFingerprints(Uint8Array.from([0xc6, 0x20, 0x04]))).toThrow(/truncated/)
    // A v6 key (RFC 9580) is refused: its fingerprint is computed differently and no pin is v6.
    expect(() => primaryKeyFingerprints(Uint8Array.from([0xc6, 0x01, 0x06]))).toThrow(/version 6/)
  })

  it('skips armor headers and tolerates CRLF line ends', () => {
    const withHeader = docker
      .replace(
        '-----BEGIN PGP PUBLIC KEY BLOCK-----\n',
        '-----BEGIN PGP PUBLIC KEY BLOCK-----\nComment: served by a CDN\n'
      )
      .replace(/\n/g, '\r\n')
    expect(dearmorPublicKey(withHeader)).toEqual(dearmorPublicKey(docker))
  })

  it('reads every new-format length encoding, and refuses partial lengths', () => {
    // Tag 13 with a two-octet length (192..8383): 0xc0 0x00 → 192 bytes.
    expect(
      primaryKeyFingerprints(Uint8Array.from([0xcd, 0xc0, 0x00, ...new Array<number>(192).fill(0x61)]))
    ).toEqual([])
    // Tag 13 with a five-octet length.
    expect(primaryKeyFingerprints(Uint8Array.from([0xcd, 0xff, 0, 0, 0, 1, 0x61]))).toEqual([])
    // A partial body length (224..254).
    expect(() => primaryKeyFingerprints(Uint8Array.from([0xcd, 0xe0, 0x61]))).toThrow(/partial/)
  })

  it('reads old-format packet headers as well as new ones', () => {
    // Old format, tag 13 (user id), one-octet length.
    expect(primaryKeyFingerprints(Uint8Array.from([0xb4, 0x01, 0x61]))).toEqual([])
    // Old format, tag 13, two-octet length.
    expect(primaryKeyFingerprints(Uint8Array.from([0xb5, 0x00, 0x01, 0x61]))).toEqual([])
    // Old format with an indeterminate length is refused.
    expect(() => primaryKeyFingerprints(Uint8Array.from([0xb7, 0x61]))).toThrow(/length/)
    // A byte that is not a packet header at all.
    expect(() => primaryKeyFingerprints(Uint8Array.from([0x01]))).toThrow(/header/)
  })
})
