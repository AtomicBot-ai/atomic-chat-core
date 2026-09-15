import { describe, expect, it } from 'vitest'
import {
  buildProcessEnv,
  discoverCudaPaths,
  exeDirOf,
  stripVerbatimPrefix,
  textMentionsCudaRuntime,
} from './env.js'

const probe = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  existing: string[],
  dirs: Record<string, string[]> = {}
) => ({
  platform,
  env,
  exists: (p: string) => existing.includes(p),
  listDir: (d: string) => dirs[d] ?? [],
})

describe('discoverCudaPaths', () => {
  it('finds Windows CUDA bins from CUDA_PATH, CUDA_PATH_V*, and Program Files, sorted and deduped', () => {
    const paths = discoverCudaPaths(
      probe(
        'win32',
        { CUDA_PATH: 'C:\\cuda\\v13', CUDA_PATH_V12_4: 'C:\\cuda\\v12', ProgramFiles: 'C:\\PF' },
        [
          'C:\\cuda\\v13\\bin',
          'C:\\cuda\\v12\\bin',
          'C:\\PF\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.4\\bin',
        ],
        { 'C:\\PF\\NVIDIA GPU Computing Toolkit\\CUDA': ['v12.4', 'v11.8'] }
      )
    )
    expect(paths.binDirs).toEqual([
      'C:\\PF\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.4\\bin',
      'C:\\cuda\\v12\\bin',
      'C:\\cuda\\v13\\bin',
    ])
    expect(paths.libDirs).toEqual([])
  })
  it('finds Linux libs and bins from CUDA_HOME, common dirs and /usr/local/cuda-*', () => {
    const paths = discoverCudaPaths(
      probe(
        'linux',
        { CUDA_HOME: '/opt/mycuda' },
        [
          '/opt/mycuda/lib64',
          '/opt/mycuda/bin',
          '/usr/local/cuda/lib64',
          '/usr/local/cuda-12.2/lib64',
          '/usr/local/cuda-12.2/bin',
        ],
        {
          '/usr/local': ['cuda-12.2', 'bin', 'cuda'],
        }
      )
    )
    expect(paths.libDirs).toEqual([
      '/opt/mycuda/lib64',
      '/usr/local/cuda-12.2/lib64',
      '/usr/local/cuda/lib64',
    ])
    expect(paths.binDirs).toEqual(['/opt/mycuda/bin', '/usr/local/cuda-12.2/bin'])
  })
  it('returns nothing on macOS', () => {
    expect(discoverCudaPaths(probe('darwin', {}, ['/usr/local/cuda/lib64']))).toEqual({
      libDirs: [],
      binDirs: [],
    })
  })
})

describe('textMentionsCudaRuntime', () => {
  it('uses the platform-specific name lists', () => {
    expect(textMentionsCudaRuntime('needs cudart64_12.dll', 'win32')).toBe(true)
    expect(textMentionsCudaRuntime('libcudart.so.12 => not found', 'linux', true)).toBe(true)
    expect(textMentionsCudaRuntime('libcudnn', 'linux', true)).toBe(true)
    expect(textMentionsCudaRuntime('libcudnn', 'linux', false)).toBe(false)
    expect(textMentionsCudaRuntime('cudart', 'darwin')).toBe(false)
  })
})

describe('buildProcessEnv', () => {
  const cuda = { libDirs: ['/cuda/lib64'], binDirs: ['/cuda/bin'] }
  it('Linux prepends exe dir and CUDA libs to LD_LIBRARY_PATH and CUDA bins to PATH', () => {
    const r = buildProcessEnv({
      platform: 'linux',
      baseEnv: { PATH: '/usr/bin', LD_LIBRARY_PATH: '/old:' },
      exeDir: '/b',
      cuda,
      userEnv: { LLAMA_API_KEY: 'k' },
    })
    expect(r.env['LD_LIBRARY_PATH']).toBe('/b:/cuda/lib64:/old')
    expect(r.env['PATH']).toBe('/cuda/bin:/usr/bin')
    expect(r.env['LLAMA_API_KEY']).toBe('k')
    expect(r.cwd).toBeUndefined()
    expect(r.cudaFound).toBe(true)
  })
  it('Windows keeps CUDA bins on PATH next to the exe dir (the fixed behaviour) and sets cwd', () => {
    const r = buildProcessEnv({
      platform: 'win32',
      baseEnv: { Path: 'C:\\Windows;' },
      exeDir: '\\\\?\\C:\\b\\bin',
      cuda: { libDirs: [], binDirs: ['C:\\cuda\\bin'] },
      userEnv: {},
    })
    expect(r.env['PATH']).toBe('C:\\b\\bin;C:\\cuda\\bin;C:\\Windows')
    expect(r.env['Path']).toBeUndefined()
    expect(r.cwd).toBe('\\\\?\\C:\\b\\bin')
  })
  it('macOS only touches DYLD_LIBRARY_PATH and reports no CUDA', () => {
    const r = buildProcessEnv({
      platform: 'darwin',
      baseEnv: {},
      exeDir: '/b',
      cuda: { libDirs: [], binDirs: [] },
      userEnv: {},
    })
    expect(r.env['DYLD_LIBRARY_PATH']).toBe('/b')
    expect(r.env['PATH']).toBeUndefined()
    expect(r.cudaFound).toBe(false)
  })
  it('helpers', () => {
    expect(stripVerbatimPrefix('\\\\?\\C:\\x')).toBe('C:\\x')
    expect(stripVerbatimPrefix('C:\\x')).toBe('C:\\x')
    expect(exeDirOf('/a/b/llama-server')).toBe('/a/b')
    expect(exeDirOf('C:\\a\\b\\llama-server.exe')).toBe('C:\\a\\b')
    expect(exeDirOf('llama-server')).toBe('.')
  })
})
