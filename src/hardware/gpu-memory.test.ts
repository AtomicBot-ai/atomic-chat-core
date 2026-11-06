import { expect, it } from 'vitest'
import { gpuMemoryMiB, hasSharedGpuMemory } from './gpu-memory.js'

it.each([
  [{ vendor: 'AMD', total_memory: 512, shared_memory: 15606 }, true, 15606],
  [{ vendor: 'AMD', total_memory: 8192, shared_memory: 4096 }, true, 8192],
  [{ vendor: 'NVIDIA', total_memory: 512, shared_memory: 15606 }, false, 512],
  [{ vendor: 'AMD', total_memory: 512, shared_memory: NaN }, false, 512],
  [{ vendor: 'AMD', total_memory: 512, shared_memory: Infinity }, false, 512],
  [{ vendor: 'AMD', total_memory: 512, shared_memory: -1 }, false, 512],
  [{ vendor: 'AMD', total_memory: Infinity }, false, 0],
  [{}, false, 0],
])('keeps shared and dedicated capacity distinct: %j', (gpu, shared, capacity) => {
  expect(hasSharedGpuMemory(gpu)).toBe(shared)
  expect(gpuMemoryMiB(gpu)).toBe(capacity)
})
