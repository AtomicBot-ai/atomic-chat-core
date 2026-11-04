/**
 * A `GeniexLibrary` that behaves as the design expects the real one to (change `add-geniex-runtime`,
 * design D1, rulings/core.md): every call blocks, `generate` calls `onToken` from inside for each
 * scripted token and ends with `cancelled` the moment the callback says stop. The chat template
 * renders the input as one JSON line, so a test can read back what reached the library.
 *
 * `FakeGeniexWorker` plays the same script from "another thread": token by token, asynchronously,
 * reading the cancel flag before each, as the real Worker's callback does.
 */

import { GENIEX_CANCELLED, GeniexLibraryError } from '../../src/runtime/geniex/host/library.js'
import type {
  GeniexGenerateResult,
  GeniexGenerationConfig,
  GeniexLibrary,
  GeniexModel,
  GeniexModelSettings,
  GeniexTemplateInput,
} from '../../src/runtime/geniex/host/library.js'

/** What a generation yields: tokens, or an error the library would return instead. */
export type FakeGeniexScript = (
  prompt: string,
  config: GeniexGenerationConfig,
  model: FakeGeniexModel
) => string[] | { error: string; code?: number }

export class FakeGeniexModel implements GeniexModel {
  readonly vision: boolean
  readonly templates: GeniexTemplateInput[] = []
  readonly generations: Array<{ prompt: string; config: GeniexGenerationConfig }> = []
  destroyed = false
  /** How many tokens were handed out, per generation (fewer than scripted after a cancel). */
  readonly delivered: number[] = []

  constructor(
    readonly settings: GeniexModelSettings,
    readonly library: FakeGeniexLibrary
  ) {
    this.vision = settings.mmproj !== null
  }

  applyChatTemplate(input: GeniexTemplateInput): string {
    this.templates.push(input)
    return `TEMPLATE ${JSON.stringify(input)}`
  }

  /** The script's answer for one generation, recorded. */
  plan(prompt: string, config: GeniexGenerationConfig): string[] | { error: string; code?: number } {
    this.generations.push({ prompt, config })
    const scripted = this.library.script(prompt, config, this)
    return Array.isArray(scripted) ? scripted.slice(0, config.maxTokens) : scripted
  }

  /** The result of a generation that handed out `given` of `scripted` tokens. */
  result(prompt: string, scripted: string[], given: number): GeniexGenerateResult {
    this.delivered.push(given)
    return {
      stopReason: scripted.length >= this.generations.at(-1)!.config.maxTokens ? 'length' : 'eos',
      promptTokens: Math.ceil(prompt.length / 4),
      generatedTokens: given,
    }
  }

  generate(
    prompt: string,
    config: GeniexGenerationConfig,
    onToken: (token: string) => boolean
  ): GeniexGenerateResult {
    this.library.active++
    this.library.maxActive = Math.max(this.library.maxActive, this.library.active)
    try {
      const scripted = this.plan(prompt, config)
      if (!Array.isArray(scripted))
        throw new GeniexLibraryError('llm_generate', scripted.error, scripted.code ?? -200101)
      let given = 0
      for (const token of scripted) {
        if (!onToken(token)) {
          this.delivered.push(given)
          throw new GeniexLibraryError('llm_generate', 'Operation cancelled by caller', GENIEX_CANCELLED)
        }
        given++
      }
      return this.result(prompt, scripted, given)
    } finally {
      this.library.active--
    }
  }

  destroy(): void {
    this.destroyed = true
  }
}

export class FakeGeniexLibrary implements GeniexLibrary {
  version: string | null = '0.9.3'
  abi = 1
  pluginList = ['llama_cpp', 'qairt']
  deviceList: Record<string, string[]> = { llama_cpp: ['HTP0', 'GPUOpenCL', 'CPU'], qairt: ['HTP0'] }
  script: FakeGeniexScript = () => ['Hello', ' world', '!']
  /** The Worker stand-in waits this long before each token. */
  tokenDelayMs = 0
  /** `createModel` throws this instead, when set. */
  createFailure: { message: string; code: number } | null = null
  readonly models: FakeGeniexModel[] = []
  active = 0
  maxActive = 0
  closed = false

  plugins(): string[] {
    return this.pluginList
  }

  devices(plugin: string): string[] {
    return this.deviceList[plugin] ?? []
  }

  createModel(settings: GeniexModelSettings): GeniexModel {
    if (this.createFailure)
      throw new GeniexLibraryError('llm_create', this.createFailure.message, this.createFailure.code)
    const model = new FakeGeniexModel(settings, this)
    this.models.push(model)
    return model
  }

  close(): void {
    this.closed = true
  }
}
