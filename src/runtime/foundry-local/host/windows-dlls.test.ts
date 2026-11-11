import { describe, expect, it } from 'vitest'
import { foundryWindowsDllDirectories } from './windows-dlls.js'

describe('foundryWindowsDllDirectories', () => {
  it('isolates managed CUDA from inherited CUDA, cuDNN, PATH and discovered Toolkit directories', () => {
    expect(
      foundryWindowsDllDirectories(
        'C:\\foundry\\lib',
        {
          ATOMIC_FOUNDRY_CUDA_CACHE_DIR: 'D:\\atomic\\cache',
          CUDA_PATH: 'C:\\CUDA\\v12.9',
          CUDNN_PATH: 'C:\\cuDNN',
          Path: 'D:\\atomic\\cache;C:\\CUDA\\v12.9\\bin;C:\\cuDNN\\bin',
        },
        ['C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.9\\bin']
      )
    ).toEqual(['C:\\foundry\\lib', 'D:\\atomic\\cache'])
  })

  it('keeps Foundry dependencies and the existing PATH while adding CUDA and cuDNN bins', () => {
    expect(
      foundryWindowsDllDirectories(
        'C:\\foundry\\lib',
        {
          CUDA_PATH: 'C:\\CUDA\\v12.9',
          CUDA_PATH_V12_8: 'D:\\CUDA\\v12.8',
          CUDNN_PATH: 'C:\\cuDNN',
          Path: 'C:\\Windows\\System32;C:\\other-provider;relative;;',
        },
        ['C:\\cuDNN\\bin\\12.9']
      )
    ).toEqual([
      'C:\\foundry\\lib',
      'C:\\CUDA\\v12.9\\bin',
      'C:\\CUDA\\v12.9\\bin\\x64',
      'D:\\CUDA\\v12.8\\bin',
      'D:\\CUDA\\v12.8\\bin\\x64',
      'C:\\cuDNN\\bin',
      'C:\\cuDNN\\bin\\x64',
      'C:\\cuDNN\\bin\\12.9',
      'C:\\Windows\\System32',
      'C:\\other-provider',
    ])
  })
  it('deduplicates Windows paths without adding relative paths or empty PATH entries', () => {
    expect(
      foundryWindowsDllDirectories('C:\\fl\\lib', { PATH: 'c:\\FL\\LIB;"C:\\cuda\\bin";.;' }, [])
    ).toEqual(['C:\\fl\\lib', 'C:\\cuda\\bin'])
  })
})
