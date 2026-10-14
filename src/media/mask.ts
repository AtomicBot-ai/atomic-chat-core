/**
 * Masks between the core's convention and a provider's. The Images page and the control API send a
 * PNG that is white where the model repaints (sd.cpp's and Automatic1111's convention); OpenAI's
 * Images API wants the opposite carrier: a transparent pixel is the one to repaint.
 */

import { decodePng, encodePng } from '../diffusion/index.js'
import { remoteError } from './http.js'

/** A pixel this bright (every channel) is "repaint". */
const WHITE_THRESHOLD = 128

/** White-means-repaint PNG → an RGBA PNG whose alpha is 0 where the model repaints, 255 elsewhere. */
export async function maskToAlpha(png: Buffer): Promise<Buffer> {
  let image
  try {
    image = await decodePng(png)
  } catch (error) {
    throw remoteError(
      'REMOTE_UNSUPPORTED',
      'The mask could not be read.',
      error instanceof Error ? error.message : String(error)
    )
  }
  const { width, height, channels, data } = image
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0, o = 0; i < data.length; i += channels, o += 4) {
    const r = data[i] as number
    const g = data[i + 1] as number
    const b = data[i + 2] as number
    const repaint = r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD
    out[o] = 0
    out[o + 1] = 0
    out[o + 2] = 0
    out[o + 3] = repaint ? 0 : 255
  }
  return encodePng({ width, height, channels: 4, data: out })
}

/**
 * An OpenAI-style mask (transparent where the model repaints) → the core's white-means-repaint PNG.
 * A mask without an alpha channel is taken to be white-means-repaint already and kept as it is.
 */
export async function alphaMaskToWhite(png: Buffer): Promise<Buffer> {
  let image
  try {
    image = await decodePng(png)
  } catch (error) {
    throw remoteError(
      'REMOTE_UNSUPPORTED',
      'The mask could not be read.',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (image.channels !== 4) return png
  const { width, height, data } = image
  const out = Buffer.alloc(width * height * 3)
  for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
    const value = (data[i + 3] as number) < 128 ? 255 : 0
    out[o] = value
    out[o + 1] = value
    out[o + 2] = value
  }
  return encodePng({ width, height, channels: 3, data: out })
}
