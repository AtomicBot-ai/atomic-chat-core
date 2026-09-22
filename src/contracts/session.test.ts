import { describe, expect, it } from 'vitest'
import type { SessionInfo } from './session.js'

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const native: SessionInfo = {
  pid: 4242,
  port: 39_411,
  model_id: 'qwen3-4b',
  model_path: '/data/llamacpp/models/qwen3-4b/model.gguf',
  is_embedding: false,
  api_key: 'sk-local',
}

describe('SessionInfo across native and managed backends', () => {
  it('leaves a native session exactly as previous releases wrote it', () => {
    // The app's Rust mirror deserialises this shape; widening the type must not change the bytes.
    expect(roundTrip(native)).toEqual(native)
    expect(JSON.parse(JSON.stringify(native))).toEqual({
      pid: 4242,
      port: 39_411,
      model_id: 'qwen3-4b',
      model_path: '/data/llamacpp/models/qwen3-4b/model.gguf',
      is_embedding: false,
      api_key: 'sk-local',
    })
    // Absent means native: every record written before managed runtimes existed is one.
    expect(roundTrip(native).execution).toBeUndefined()
  })

  it('carries a container session with no host process id at all', () => {
    const container: SessionInfo = {
      ...native,
      pid: null,
      execution: 'container',
      generation: 'g7',
      model_path: '/data/atomic-core/managed-runtimes/artifacts/nvidia%2FLlama-3.1-8B-Instruct-FP8',
    }
    const back = roundTrip(container)
    expect(back).toEqual(container)
    // Null, not missing: a client can tell "no process" from "this build has no such field".
    expect(back.pid).toBeNull()
    expect('pid' in back).toBe(true)
    expect(back.execution).toBe('container')
    expect(back.generation).toBe('g7')
  })

  it('keeps the port and key, which are how any caller reaches either kind', () => {
    const container: SessionInfo = { ...native, pid: null, execution: 'container' }
    expect(container.port).toBe(native.port)
    expect(container.api_key).toBe(native.api_key)
  })
})
