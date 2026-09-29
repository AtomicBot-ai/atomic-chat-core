import { describe, expect, it } from 'vitest'
import {
  decodeTilingParams,
  engineDefaultLayout,
  ENGINE_TILE_LATENT,
  tileSideFor,
  tilesAlong,
  tilingLayout,
} from './video-tiling.js'

describe('tilesAlong', () => {
  it.each([
    // [axis, tile, tiles] — worked by hand through sd.cpp's `sd_tiling_calc_tiles`.
    [32, 32, 1], // the axis fits in one tile
    [20, 32, 1],
    [44, 32, 2], // 704 px on the Wan VAE: one tile short, and never fewer than two
    [80, 32, 4], // 1280 px: overshoot equals the stride, no extra tile
    [38, 32, 2], // 1216 px on the LTX VAE
    [64, 32, 3],
    [100, 32, 5],
    [80, 53, 2],
    [80, 40, 3],
    [44, 29, 2],
  ])('an axis of %i latent pixels in tiles of %i is %i tiles', (axis, tile, tiles) => {
    expect(tilesAlong(axis, tile)).toBe(tiles)
  })

  it('squeezes in one more tile when the last would overshoot by little, below half overlap', () => {
    // Overlap 8, stride 24: three tiles overshoot by 4, within 3 × (16 − 8), so a fourth fits.
    expect(tilesAlong(100, 32, 0.25)).toBe(4)
    // At sd.cpp's default half overlap that room is always zero.
    expect(tilesAlong(100, 32, 0.5)).toBe(5)
  })
})

describe('tileSideFor', () => {
  it('turns a tile count into the side sd.cpp takes, and one tile into the whole axis', () => {
    expect(tileSideFor(80, 1)).toBe(80)
    expect(tileSideFor(80, 0)).toBe(80)
    // size / (n − n·0.5 + 0.5): 80 / 1.5, 80 / 2.5, 44 / 1.5.
    expect(tileSideFor(80, 2)).toBe(53)
    expect(tileSideFor(80, 4)).toBe(32)
    expect(tileSideFor(44, 2)).toBe(29)
    // Never below four latent pixels, never past the axis.
    expect(tileSideFor(8, 20)).toBe(4)
    expect(tileSideFor(3, 5)).toBe(3)
  })

  it('asks for the counts it was given: a requested count comes back as the tiles the engine runs', () => {
    for (const axis of [22, 38, 44, 80])
      for (let count = 1; count <= tilesAlong(axis, Math.min(ENGINE_TILE_LATENT, axis)); count++)
        expect(tilesAlong(axis, tileSideFor(axis, count)), `${axis} in ${count}`).toBe(count)
  })
})

describe('tilingLayout', () => {
  it('prices the overlap: sd.cpp’s own tiles on 704×1280 at the Wan VAE do 2.33 times the work', () => {
    const layout = engineDefaultLayout(44, 80)
    expect(layout).toMatchObject({ tiled: true, tilesX: 2, tilesY: 4, tileWidth: 32, tileHeight: 32 })
    expect(layout.work).toBeCloseTo((8 * 32 * 32) / (44 * 80), 9)
    expect(layout.work).toBeCloseTo(2.327, 3)
  })

  it('is one graph for 1 × 1 and the requested tiles otherwise', () => {
    expect(tilingLayout(44, 80, { tilesX: 1, tilesY: 1 })).toEqual({
      tiled: false,
      tilesX: 1,
      tilesY: 1,
      tileWidth: 44,
      tileHeight: 80,
      work: 1,
    })
    const strips = tilingLayout(44, 80, { tilesX: 1, tilesY: 4 })
    expect(strips).toMatchObject({ tiled: true, tilesX: 1, tilesY: 4, tileWidth: 44, tileHeight: 32 })
    expect(strips.work).toBeCloseTo(1.6, 9)
    const halves = tilingLayout(44, 80, { tilesX: 1, tilesY: 2 })
    expect(halves).toMatchObject({ tilesX: 1, tilesY: 2, tileHeight: 53 })
    expect(halves.work).toBeCloseTo(106 / 80, 9)
  })

  it('takes a frame smaller than a tile whole', () => {
    expect(engineDefaultLayout(16, 20)).toMatchObject({
      tilesX: 1,
      tilesY: 1,
      tileWidth: 16,
      tileHeight: 20,
      work: 1,
    })
  })
})

describe('decodeTilingParams', () => {
  it('sends tile counts under both spellings sd.cpp has used, and nothing for one graph', () => {
    expect(decodeTilingParams({ tilesX: 1, tilesY: 1 })).toBeUndefined()
    expect(decodeTilingParams({ tilesX: 1, tilesY: 4 })).toEqual({
      enabled: true,
      rel_size_x: 1,
      rel_size_y: 4,
      rel_size_w: 1,
      rel_size_h: 4,
    })
    expect(decodeTilingParams({ tilesX: 2, tilesY: 0 })).toMatchObject({ rel_size_x: 2, rel_size_y: 1 })
  })
})
