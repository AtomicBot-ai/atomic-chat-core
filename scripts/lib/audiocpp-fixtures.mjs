// What audio.cpp's live tests run on (`node scripts/fetch-live-fixtures.mjs --engine audio-cpp`): this
// host's CPU archive of a release, unpacked alone into its own folder, the model files of the
// config's `live_models` (MOSS-TTS-Nano) checked against their sha256 in a folder of their own, a manifest of
// the release for the install test (ATOMIC_AUDIOCPP_MANIFEST_URL), and what the build prints for
// `--help`, `--version` and `--list-devices` (help.txt, version.txt, list-devices.txt: the shape of
// test/fixtures/audiocpp/v<version>/). sd.cpp's fetch (sdcpp-fixtures.mjs) with audio.cpp's release
// spec: the archive choice and the manifest are pure, `fetchAudiocppFixtures` does the downloads.
import { AUDIOCPP_RELEASE } from './audiocpp-surface.mjs'
import { fetchReleaseFixtures, releaseHostArchive, releaseInstallManifest } from './sdcpp-fixtures.mjs'

/**
 * The CPU archive of `platform` (`linux-x64`, `macos-arm64`, …) in a release's `assets`: the backend
 * every host of that platform falls back to. Throws when the contract has none for the platform or
 * the release has none or two.
 */
export function audiocppHostArchive(contract, tag, assets, platform) {
  return releaseHostArchive(contract, tag, assets, platform, AUDIOCPP_RELEASE)
}

/**
 * conf's audio.cpp manifest for `repo`@`tag`, as conf's mirror would write it: every archive a
 * contract backend takes, pinned by its size and the sha256 of the release's digest, downloaded from
 * the release itself (`download_base`, under the tag as the release has it, `-a<rev>` included).
 */
export function audiocppInstallManifest(input) {
  return releaseInstallManifest(input, AUDIOCPP_RELEASE)
}

/** audio.cpp's release spec with what its fetch needs: `audiocpp_server` and its three captures. */
const AUDIOCPP_FIXTURES = {
  ...AUDIOCPP_RELEASE,
  server: 'audiocpp_server',
  executables: ['audiocpp_server', 'audiocpp_cli'],
  engineEnv: 'ATOMIC_LIVE_AUDIO_ENGINE',
  captures: [
    { file: 'help.txt', argv: ['--help'] },
    { file: 'version.txt', argv: ['--version'] },
    { file: 'list-devices.txt', argv: ['--list-devices'] },
  ],
}

/** Everything one live cell of audio.cpp needs, under `out` (`fetchReleaseFixtures`). */
export function fetchAudiocppFixtures(input) {
  return fetchReleaseFixtures(input, AUDIOCPP_FIXTURES)
}
