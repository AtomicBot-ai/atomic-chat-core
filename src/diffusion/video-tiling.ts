/**
 * How a clip's VAE decode is split into spatial tiles, as sd.cpp splits it. Every tile runs the
 * decoder over all the clip's frames and the tiles overlap by half, so a tiled decode recomputes the
 * overlap: 704×1280 on the Wan 2.2 VAE (a 44×80 latent) in sd.cpp's default 32-pixel tiles is 2×4
 * tiles, 2.33 times the work of one graph. Pure; the choice of tiling is `planDecodeTiling` in
 * `video-estimate.ts`.
 */

/**
 * The tiles across and down a decode is asked for; 1 × 1 is one graph over the whole frame. Sent as
 * tile counts (`rel_size_*` above 1), which sd.cpp reads the same way in every build, where the unit
 * of an absolute tile size changed from latent to image pixels upstream (sd.cpp #2059).
 */
export interface VideoDecodeTiling {
  tilesX: number
  tilesY: number
}

/** sd.cpp's default tile before #2059: 32 latent pixels on a side. */
export const ENGINE_TILE_LATENT = 32
/** sd.cpp's default overlap between neighbouring tiles, a share of the tile. */
export const DECODE_TILE_OVERLAP = 0.5
/** sd.cpp's smallest tile side in latent pixels. */
export const MIN_TILE_LATENT = 4

/**
 * Tiles along one axis of `size` latent pixels for tiles of `tile`, counted as sd.cpp's
 * `sd_tiling_calc_tiles` counts them (the non-circular branch): an extra tile when the last one would
 * overshoot by little, and never fewer than two once the axis is longer than a tile.
 */
export function tilesAlong(size: number, tile: number, overlap = DECODE_TILE_OVERLAP): number {
  if (size <= tile) return 1
  const tileOverlap = Math.trunc(tile * overlap)
  const nonOverlap = tile - tileOverlap
  let count = Math.trunc((size - tileOverlap) / nonOverlap)
  const overshoot = ((count + 1) * nonOverlap + tileOverlap) % size
  if (overshoot !== nonOverlap && overshoot <= count * (Math.trunc(tile / 2) - tileOverlap)) count += 1
  return Math.max(count, 2)
}

/**
 * The tile side sd.cpp takes for `count` tiles along `size` (`rel_size` above 1): `size / (count −
 * count·overlap + overlap)`, rounded as the pinned build rounds it; the whole axis for one tile.
 */
export function tileSideFor(size: number, count: number, overlap = DECODE_TILE_OVERLAP): number {
  if (count <= 1) return size
  const side = Math.round(size / (count - count * overlap + overlap))
  return Math.max(Math.min(side, size), Math.min(MIN_TILE_LATENT, size))
}

/** What one tiling costs: the tiles the engine will run, their side in latent pixels, and the work. */
export interface DecodeLayout {
  tiled: boolean
  tilesX: number
  tilesY: number
  /** Latent pixels on a side of one tile. */
  tileWidth: number
  tileHeight: number
  /** The decoder's work against one graph over the frame: the tiles' area over the latent's. */
  work: number
}

/** The layout of `tiling` over a latent of `width` × `height` pixels; one graph when `tiling` is 1 × 1. */
export function tilingLayout(width: number, height: number, tiling: VideoDecodeTiling): DecodeLayout {
  if (tiling.tilesX <= 1 && tiling.tilesY <= 1)
    return { tiled: false, tilesX: 1, tilesY: 1, tileWidth: width, tileHeight: height, work: 1 }
  const tileWidth = tileSideFor(width, tiling.tilesX)
  const tileHeight = tileSideFor(height, tiling.tilesY)
  return tiledLayout(width, height, tileWidth, tileHeight)
}

/** The layout of sd.cpp's own tiles (32 latent pixels) when a request only switches tiling on. */
export function engineDefaultLayout(width: number, height: number): DecodeLayout {
  return tiledLayout(width, height, Math.min(ENGINE_TILE_LATENT, width), Math.min(ENGINE_TILE_LATENT, height))
}

function tiledLayout(width: number, height: number, tileWidth: number, tileHeight: number): DecodeLayout {
  const tilesX = tilesAlong(width, tileWidth)
  const tilesY = tilesAlong(height, tileHeight)
  const work = (tilesX * tileWidth * tilesY * tileHeight) / Math.max(width * height, 1)
  return { tiled: true, tilesX, tilesY, tileWidth, tileHeight, work }
}

/**
 * The `vae_tiling_params` of a tiled decode: tile counts under both spellings sd.cpp has used
 * (`rel_size_x/y` up to the pinned build, `rel_size_w/h` after #2059); a build reads its own and
 * ignores the other. Undefined for one graph.
 */
export function decodeTilingParams(tiling: VideoDecodeTiling): Record<string, unknown> | undefined {
  if (tiling.tilesX <= 1 && tiling.tilesY <= 1) return undefined
  const x = Math.max(tiling.tilesX, 1)
  const y = Math.max(tiling.tilesY, 1)
  return { enabled: true, rel_size_x: x, rel_size_y: y, rel_size_w: x, rel_size_h: y }
}
