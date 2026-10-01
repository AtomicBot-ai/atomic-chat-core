#!/usr/bin/env node
/**
 * A fake `wsl.exe` for the Windows managed-runtime tests (change `add-tensorrt-llm-windows`, design
 * D16). Run as `node fake-wsl.mjs <state-dir> ...wsl-args` — the transport's injectable executable
 * is `process.execPath` with this script and the folder as leading arguments — so it runs the same on
 * a Windows runner as on macOS or Linux: no `.cmd`, no shell, no POSIX wrapper.
 *
 * `<state-dir>/state.json` describes the machine as WSL sees it:
 *   { installed, wsl_version, default_version, kernel, distributions: [{ name, state, version,
 *     is_default }], guests: { <name>: <fake-linux-host state> } }
 * Every call is appended to `<state-dir>/calls.jsonl` as `{ argv, wsl_utf8 }`, so a test asserts the
 * exact argv the transport built and that it asked for UTF-8 (`WSL_UTF8=1`).
 *
 * Like the real one, `wsl.exe`'s own messages (`--list --verbose`, `--status`, `--version`, its
 * errors) come out as UTF-16LE unless `WSL_UTF8=1`, while a command run with `--exec` writes its own
 * bytes (UTF-8) untouched. A `-d <name> --exec` command runs in the guest: a few built-ins here
 * (`echo`, `cat`, `sleep`, `true`, `false`, and the test-only `fake-flood`, `fake-stream`), every
 * other command answered by `fake-linux-host.mjs`'s `answer` against that guest's state.
 *
 * `sleep infinity` — what the core holds a distribution with — runs until `<state-dir>/stopped`
 * exists (a test's `wsl --shutdown`) or the process is killed. `--shutdown` creates that file.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, ...argv] = process.argv.slice(2)
const statePath = join(dir, 'state.json')
const readState = () =>
  existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { installed: true, distributions: [], guests: {} }

appendFileSync(
  join(dir, 'calls.jsonl'),
  `${JSON.stringify({ argv, wsl_utf8: process.env.WSL_UTF8 ?? null })}\n`
)

const utf8Mode = process.env.WSL_UTF8 === '1'
/** `wsl.exe`'s own voice: UTF-16LE, unless asked for UTF-8. */
const own = (text) => (utf8Mode ? Buffer.from(text, 'utf8') : Buffer.from(text, 'utf16le'))

const exit = (code, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)) => {
  process.stdout.write(stdout, () =>
    process.stderr.write(stderr, () => {
      process.exitCode = code
    })
  )
}

function ownCommand(state, args) {
  if (state.installed === false) {
    // No WSL at all: the inbox stub only offers to install it.
    return exit(1, own('Windows Subsystem for Linux is not installed.\r\n'))
  }
  switch (args[0]) {
    case '--list': {
      const rows = (state.distributions ?? []).map(
        (d) => `${d.is_default ? '*' : ' '} ${d.name.padEnd(16)}${d.state.padEnd(16)}${d.version}\r\n`
      )
      return exit(0, own(`  NAME            STATE           VERSION\r\n${rows.join('')}`))
    }
    case '--status':
      return exit(
        0,
        own(
          `Default Version: ${state.default_version ?? 2}\r\nKernel version: ${state.kernel ?? '6.6.87.2-1'}\r\n`
        )
      )
    case '--version':
      return exit(
        0,
        own(
          `WSL version: ${state.wsl_version ?? '2.4.4.0'}\r\nKernel version: ${state.kernel ?? '6.6.87.2-1'}\r\n`
        )
      )
    case '--shutdown':
      writeFileSync(join(dir, 'stopped'), '')
      return exit(0)
    default:
      return exit(1, own(`Invalid command line argument: ${args[0]}\r\n`))
  }
}

async function guestCommand(state, name, command, args) {
  const distribution = (state.distributions ?? []).find((d) => d.name === name)
  if (distribution === undefined) {
    return exit(4294967295 & 0xff, own('There is no distribution with the supplied name.\r\n'))
  }
  switch (command) {
    case 'echo':
      return exit(0, Buffer.from(`${args.join(' ')}\n`, 'utf8'))
    case 'true':
      return exit(0)
    case 'false':
      return exit(1)
    case 'cat': {
      if (args.length === 0) {
        const chunks = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        return exit(0, Buffer.concat(chunks))
      }
      return exit(1, Buffer.alloc(0), Buffer.from(`cat: ${args[0]}: No such file or directory\n`))
    }
    case 'sleep': {
      // Held until the VM goes away (`wsl --shutdown`) or the core kills this process.
      const stopped = join(dir, 'stopped')
      const timer = setInterval(() => {
        if (existsSync(stopped)) {
          clearInterval(timer)
          exit(1)
        }
      }, 20)
      return undefined
    }
    case 'fake-flood':
      return exit(0, Buffer.alloc(Number(args[0]), 'x'))
    case 'fake-stream': {
      // One line per tick, so a reader sees them arrive one by one.
      for (const line of args) {
        process.stdout.write(`${line}\n`)
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      return exit(0)
    }
    default: {
      const { answer } = await import('./fake-linux-host.mjs')
      const guest = state.guests?.[name] ?? {}
      const result = answer(guest, command, args)
      return exit(result.code, Buffer.from(result.stdout, 'utf8'), Buffer.from(result.stderr, 'utf8'))
    }
  }
}

const state = readState()
if (argv[0] === '-d') {
  const name = argv[1]
  let rest = argv.slice(2)
  if (rest[0] === '-u') rest = rest.slice(2)
  if (rest[0] !== '--exec') {
    exit(1, own(`fake wsl: expected --exec, got ${rest.join(' ')}\r\n`))
  } else {
    await guestCommand(state, name, rest[1], rest.slice(2))
  }
} else {
  ownCommand(state, argv)
}
