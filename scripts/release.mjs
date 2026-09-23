#!/usr/bin/env node
// The release command, like the app's scripts/release.sh: bump the core version, commit, tag.
// Pushing the tag makes .github/workflows/release.yml run the CI gates, build every binary and
// publish the GitHub release the app downloads. `make release` runs it with --push.
//
//   npm run release -- patch    # 0.3.0 → 0.3.1
//   npm run release -- minor    # 0.3.0 → 0.4.0
//   npm run release -- major    # 0.3.0 → 1.0.0
//   npm run release -- 1.2.3    # an explicit version; the current one only tags HEAD
//   npm run release -- patch --push   # and push the branch and the tag: publish it
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_JSON = join(ROOT, 'package.json')
const VERSION_TS = join(ROOT, 'src/version.ts')
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

function git(...args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (res.status !== 0)
    fail(`git ${args.join(' ')} failed: ${(res.stderr || res.error?.message || '').trim()}`)
  return res.stdout.trim()
}

function parse(version) {
  const match = SEMVER.exec(version)
  if (!match) fail(`${version} is not X.Y.Z`)
  return match.slice(1).map(Number)
}

function nextVersion(current, bump) {
  const [major, minor, patch] = parse(current)
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'major') return `${major + 1}.0.0`
  if (SEMVER.test(bump ?? '')) return bump
  fail('usage: npm run release -- <patch|minor|major|X.Y.Z> [--push]')
}

function isBelow(a, b) {
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}

/** Exactly one match, so a changed file layout fails loudly instead of skipping the bump. */
function replaceOnce(path, pattern, replacement) {
  const text = readFileSync(path, 'utf8')
  const count = [...text.matchAll(new RegExp(pattern.source, 'gm'))].length
  if (count !== 1) fail(`expected one version line in ${path}, found ${count}`)
  writeFileSync(path, text.replace(pattern, replacement))
}

const args = process.argv.slice(2)
const push = args.includes('--push')
const current = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).version
const next = nextVersion(
  current,
  args.find((arg) => arg !== '--push')
)
const tag = `v${next}`

if (isBelow(next, current)) fail(`${next} is below the current ${current}`)
if (git('status', '--porcelain')) fail('the working tree has changes; commit or stash them first')
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists here`)
if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) fail(`tag ${tag} already exists on origin`)

if (next !== current) {
  replaceOnce(PACKAGE_JSON, /^ {2}"version": "[^"]+",$/m, `  "version": "${next}",`)
  replaceOnce(VERSION_TS, /^export const CORE_VERSION = '[^']+'$/m, `export const CORE_VERSION = '${next}'`)
  git('add', PACKAGE_JSON, VERSION_TS)
  git('commit', '--quiet', '-m', `release: ${tag}`)
  console.log(`Bumped ${current} → ${next}`)
}
git('tag', '--annotate', tag, '--message', `atomic-chat-core ${tag}`)

const branch = git('branch', '--show-current')
console.log(`Tagged ${tag} on ${git('rev-parse', '--short', 'HEAD')} (${branch}).`)
// `origin HEAD`, not a bare push: the branch may have no upstream yet.
const pushArgs = ['push', '--follow-tags', 'origin', 'HEAD']
if (!push) {
  console.log(`\nPublish it:\n  git ${pushArgs.join(' ')}\n`)
} else if (spawnSync('git', pushArgs, { cwd: ROOT, stdio: 'inherit' }).status !== 0) {
  fail(`the push failed; ${tag} is tagged here, retry with: git ${pushArgs.join(' ')}`)
} else {
  console.log(`\nPushed ${branch} and ${tag}. Follow the release: gh run list --workflow release.yml`)
}
console.log('The release workflow runs the CI gates, builds every binary and publishes the release.')
