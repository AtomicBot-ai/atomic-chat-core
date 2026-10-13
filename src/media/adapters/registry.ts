/**
 * Every adapter this core has, by the dialect it speaks. The catalog names dialects; a dialect
 * missing here is one this core cannot talk to (the catalog parser already drops its entries).
 */

import type { MediaDialect } from '../../contracts/index.js'
import { A1111 } from './a1111.js'
import { AIMLAPI_VIDEOS } from './aimlapi-videos.js'
import { DASHSCOPE_IMAGE } from './dashscope-image.js'
import { DASHSCOPE_VIDEO } from './dashscope-video.js'
import { GEMINI_IMAGE } from './gemini-image.js'
import { GEMINI_VEO } from './gemini-veo.js'
import { HF_IMAGES } from './hf-images.js'
import { HF_VIDEOS } from './hf-videos.js'
import { MINIMAX_IMAGE } from './minimax-image.js'
import { MINIMAX_VIDEO } from './minimax-video.js'
import { MINIMAX_VIDEO_V2 } from './minimax-video-v2.js'
import { MISTRAL_AGENT_IMAGE } from './mistral-agent-image.js'
import { NVIDIA_GENAI } from './nvidia-genai.js'
import { OPENAI_IMAGES } from './openai-images.js'
import { OPENAI_VIDEOS } from './openai-videos.js'
import { OPENROUTER_IMAGES } from './openrouter-images.js'
import { OPENROUTER_VIDEOS } from './openrouter-videos.js'
import type { MediaAdapter } from './types.js'
import { XAI_IMAGES } from './xai-images.js'
import { XAI_VIDEOS } from './xai-videos.js'

export const MEDIA_ADAPTERS: Readonly<Record<MediaDialect, MediaAdapter>> = {
  'openai-images': OPENAI_IMAGES,
  'xai-images': XAI_IMAGES,
  'openrouter-images': OPENROUTER_IMAGES,
  'gemini-image': GEMINI_IMAGE,
  'minimax-image': MINIMAX_IMAGE,
  'dashscope-image': DASHSCOPE_IMAGE,
  'hf-images': HF_IMAGES,
  'nvidia-genai': NVIDIA_GENAI,
  'mistral-agent-image': MISTRAL_AGENT_IMAGE,
  'a1111': A1111,
  'openai-videos': OPENAI_VIDEOS,
  'openrouter-videos': OPENROUTER_VIDEOS,
  'xai-videos': XAI_VIDEOS,
  'gemini-veo': GEMINI_VEO,
  'minimax-video': MINIMAX_VIDEO,
  'minimax-video-v2': MINIMAX_VIDEO_V2,
  'dashscope-video': DASHSCOPE_VIDEO,
  'aimlapi-videos': AIMLAPI_VIDEOS,
  'hf-videos': HF_VIDEOS,
}
