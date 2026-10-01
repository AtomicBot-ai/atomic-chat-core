#!/usr/bin/env node
/**
 * A fake `wsl.exe` for the Windows managed-runtime tests (change `add-tensorrt-llm-windows`, design
 * D16). Two ways in:
 *
 * - `answerWsl(state, argv, input)` is the pure part: what `wsl.exe <argv>` prints on the machine
 *   `state` describes, and the state after it. Unit tests drive it in memory
 *   (`test/helpers/fake-windows-host.ts`).
 * - Run as a program — `node fake-wsl.mjs <state-dir> ...wsl-args`, the transport's injectable
 *   executable being `process.execPath` with this script and the folder in front — it reads
 *   `<state-dir>/state.json`, answers, writes the next state back and appends `{ argv, wsl_utf8 }` to
 *   `<state-dir>/calls.jsonl`. No `.cmd`, no shell, no POSIX wrapper: it runs the same on a Windows
 *   runner as anywhere else.
 *
 * The state (`FakeWslState` in `fake-wsl.d.mts`): whether WSL is installed and its version, whether
 * `--status` answers, the registered distributions, and per distribution a guest — a
 * `fake-linux-host.mjs` state (Docker, toolkit, GPUs, …) plus the guest's files, its free disk and
 * the NVML version WSL hands it.
 *
 * Like the real one, `wsl.exe`'s own messages come out as UTF-16LE unless `WSL_UTF8=1`, while a
 * command run with `--exec` writes its own bytes (UTF-8). `sleep infinity` — what the core holds a
 * distribution with — runs until `<state-dir>/stopped` exists (`wsl --shutdown`, or a test) or the
 * process is killed.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer as answerLinux } from './fake-linux-host.mjs'

const NO_DISTRIBUTION = 'There is no distribution with the supplied name.\r\n'

const bytes = (text) => Buffer.from(text, 'utf8')
const result = (code, stdout = '', stderr = '', extra = {}) => ({
  code,
  stdout: typeof stdout === 'string' ? bytes(stdout) : stdout,
  stderr: typeof stderr === 'string' ? bytes(stderr) : stderr,
  ...extra,
})

/** The guest's view of one distribution: its files, free disk, NVML version and the Linux host fake. */
function guestOf(state, name) {
  return state.guests?.[name] ?? { files: {}, host: { driver: null, docker: {}, toolkit: false } }
}

function withGuest(state, name, guest) {
  return { ...state, guests: { ...(state.guests ?? {}), [name]: guest } }
}

function guestCommand(state, name, user, command, args, input) {
  const guest = guestOf(state, name)
  const files = guest.files ?? {}
  const base = command.split('/').pop()
  switch (base) {
    case 'echo':
      return result(0, `${args.join(' ')}\n`)
    case 'true':
      return result(0)
    case 'false':
      return result(1)
    case 'test': {
      const path = args[args.length - 1]
      const exists = path in files || (guest.dirs ?? []).includes(path)
      return result(exists ? 0 : 1)
    }
    case 'cat': {
      if (args.length === 0) return result(0, input ?? Buffer.alloc(0))
      const path = args[args.length - 1]
      return path in files
        ? result(0, files[path])
        : result(1, '', `cat: ${path}: No such file or directory\n`)
    }
    case 'df': {
      const free = guest.free_disk_bytes
      return free === undefined || free === null
        ? result(1, '', 'df: cannot read\n')
        : result(0, `   Avail\n${free}\n`)
    }
    case 'nvidia-smi':
      if (args[0] === '--version') {
        return guest.nvml_version === undefined || guest.nvml_version === null
          ? result(127, '', 'nvidia-smi: command not found\n')
          : result(
              0,
              `NVIDIA-SMI version  : ${guest.nvml_version}\nNVML version        : ${guest.nvml_version}\n` +
                `DRIVER version      : ${guest.host?.driver ?? ''}\nCUDA Version        : 13.0\n`
            )
      }
      break
    case 'sleep':
      return result(0, '', '', { hold: true })
    case 'fake-flood':
      return result(0, Buffer.alloc(Number(args[0]), 'x'))
    case 'fake-stream':
      return result(0, '', '', { stream: args })
  }
  const answered = answerLinux({ ...(guest.host ?? {}), user }, base, args)
  const next =
    answered.next === undefined ? undefined : withGuest(state, name, { ...guest, host: answered.next })
  return result(answered.code, answered.stdout, answered.stderr, next === undefined ? {} : { next })
}

/**
 * What `wsl.exe <argv>` answers on `state`. `own(text)` encodes `wsl.exe`'s own voice (UTF-16LE unless
 * the caller asked for UTF-8). `hold`/`stream` mark the two answers a program has to act out in time.
 */
export function answerWsl(state, argv, input = undefined, utf8 = true) {
  const own = (text) => (utf8 ? bytes(text) : Buffer.from(text, 'utf16le'))
  if (argv[0] === '-d') {
    const name = argv[1]
    let rest = argv.slice(2)
    let user = 'root'
    if (rest[0] === '-u') {
      user = rest[1]
      rest = rest.slice(2)
    } else {
      user = state.guests?.[name]?.default_user ?? 'root'
    }
    if (rest[0] !== '--exec') return result(1, own(`fake wsl: expected --exec, got ${rest.join(' ')}\r\n`))
    if (state.installed === false || state.ready === false) {
      return result(1, own('The Windows Subsystem for Linux is not available.\r\n'))
    }
    if (!(state.distributions ?? []).some((d) => d.name === name)) return result(255, own(NO_DISTRIBUTION))
    return guestCommand(state, name, user, rest[1], rest.slice(2), input)
  }

  if (state.installed === false) {
    // The inbox stub of a machine without the WSL package only offers to install it.
    return result(1, own('The Windows Subsystem for Linux is not installed.\r\n'))
  }
  switch (argv[0]) {
    case '--version':
      return result(
        0,
        own(`WSL version: ${state.wsl_version ?? '2.4.4.0'}\r\nKernel version: 6.6.87.2-1\r\n`)
      )
    case '--status':
      return state.ready === false
        ? result(
            1,
            own(
              'Please enable the Virtual Machine Platform Windows feature and ensure virtualization is enabled in the BIOS.\r\n'
            )
          )
        : result(0, own('Default Version: 2\r\n'))
    case '--list': {
      const distributions = state.distributions ?? []
      if (distributions.length === 0) {
        return result(255, own('Windows Subsystem for Linux has no installed distributions.\r\n'))
      }
      const rows = distributions.map(
        (d) => `${d.is_default ? '*' : ' '} ${d.name.padEnd(16)}${d.state.padEnd(16)}${d.version}\r\n`
      )
      return result(0, own(`  NAME            STATE           VERSION\r\n${rows.join('')}`))
    }
    case '--shutdown':
      return result(0, '', '', {
        next: {
          ...state,
          distributions: (state.distributions ?? []).map((d) => ({ ...d, state: 'Stopped' })),
        },
        shutdown: true,
      })
    default:
      return result(1, own(`Invalid command line argument: ${argv[0]}\r\n`))
  }
}

// Run as a program: `node fake-wsl.mjs <state-dir> ...wsl-args`.
if (process.argv[1] && /fake-wsl\.mjs$/.test(process.argv[1])) {
  const [dir, ...argv] = process.argv.slice(2)
  const statePath = join(dir, 'state.json')
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { installed: true, distributions: [], guests: {} }
  appendFileSync(
    join(dir, 'calls.jsonl'),
    `${JSON.stringify({ argv, wsl_utf8: process.env.WSL_UTF8 ?? null })}\n`
  )

  let input
  const execAt = argv.indexOf('--exec')
  if (execAt !== -1 && argv[execAt + 1] === 'cat' && argv.length === execAt + 2) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    input = Buffer.concat(chunks)
  }

  const answered = answerWsl(state, argv, input, process.env.WSL_UTF8 === '1')
  if (answered.next !== undefined) writeFileSync(statePath, JSON.stringify(answered.next, null, 2))
  if (answered.shutdown) writeFileSync(join(dir, 'stopped'), '')

  const done = () => {
    process.stdout.write(answered.stdout, () =>
      process.stderr.write(answered.stderr, () => {
        process.exitCode = answered.code
      })
    )
  }
  if (answered.hold) {
    // Held until the VM goes away (`wsl --shutdown`) or the core kills this process.
    const stopped = join(dir, 'stopped')
    const timer = setInterval(() => {
      if (existsSync(stopped)) {
        clearInterval(timer)
        process.exitCode = 1
      }
    }, 20)
  } else if (answered.stream) {
    // One line per tick, so a reader sees them arrive one by one.
    for (const line of answered.stream) {
      process.stdout.write(`${line}\n`)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  } else {
    done()
  }
}
