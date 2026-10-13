import { describe, expect, it } from 'vitest'
import { decodePng, encodePng } from '../diffusion/index.js'
import { alphaMaskToWhite, maskToAlpha } from './mask.js'

/** A 2×1 RGB mask: white (repaint) then black (keep). */
const whiteBlack = () =>
  encodePng({ width: 2, height: 1, channels: 3, data: Buffer.from([255, 255, 255, 0, 0, 0]) })

describe('maskToAlpha', () => {
  it('makes the white pixels transparent and the rest opaque', async () => {
    const out = await decodePng(await maskToAlpha(await whiteBlack()))
    expect(out.channels).toBe(4)
    expect([out.data[3], out.data[7]]).toEqual([0, 255])
  })

  it('refuses bytes that are not a PNG it reads', async () => {
    await expect(maskToAlpha(Buffer.from('nope'))).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
  })
})

describe('alphaMaskToWhite', () => {
  it('turns transparent pixels white and opaque ones black, round-tripping maskToAlpha', async () => {
    const out = await decodePng(await alphaMaskToWhite(await maskToAlpha(await whiteBlack())))
    expect(out.channels).toBe(3)
    expect([...out.data]).toEqual([255, 255, 255, 0, 0, 0])
  })

  it('keeps a mask without alpha as it is', async () => {
    const png = await whiteBlack()
    expect(await alphaMaskToWhite(png)).toBe(png)
  })
})
