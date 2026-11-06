import { ATOMIC_MODEL_CATALOG_URL, parseAtomicModelCatalog } from './model-catalog.js'

const CONF = 'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main'
export const FASTFLOWLM_MANIFEST_URL = CONF + '/backends/fastflowlm-manifest.json'
export type AtomicSourceOverrides = Partial<
  Record<
    | 'ATOMIC_MODEL_CATALOG_URL'
    | 'ATOMIC_FASTFLOWLM_MANIFEST_URL'
    | 'ATOMIC_FASTFLOWLM_ENVIRONMENT_MANIFEST_URL',
    string
  >
>

/** Resolve developer sources once for a client snapshot. Only the host or a desktop relay reads files. */
export function fastFlowLmSources(platform: 'win32' | 'linux', overrides: AtomicSourceOverrides = {}) {
  return {
    catalog: documentUrl(overrides.ATOMIC_MODEL_CATALOG_URL ?? ATOMIC_MODEL_CATALOG_URL),
    builds: documentUrl(overrides.ATOMIC_FASTFLOWLM_MANIFEST_URL ?? FASTFLOWLM_MANIFEST_URL),
    environment: documentUrl(
      overrides.ATOMIC_FASTFLOWLM_ENVIRONMENT_MANIFEST_URL ??
        CONF + '/runtimes/environments/fastflowlm-' + (platform === 'win32' ? 'windows' : 'linux') + '.json'
    ),
  }
}

function documentUrl(value: string) {
  const url = new URL(value)
  if (
    (url.protocol !== 'https:' && url.protocol !== 'file:') ||
    url.username ||
    url.password ||
    (url.protocol === 'file:' &&
      (url.hostname || url.pathname.startsWith('//') || !value.startsWith('file:///')))
  )
    throw new Error('Expected an HTTPS or local file URL for the catalog source')
  return url.href
}

export interface AtomicDocumentTransport {
  fetch?: typeof fetch
  readLocal?: (url: string) => Promise<string>
}

/** Read a JSON document from conf or an explicit local fixture. Network failures propagate to the caller. */
export async function readAtomicDocument(
  source: string,
  transport: AtomicDocumentTransport = {}
): Promise<unknown> {
  const url = documentUrl(source)
  if (url.startsWith('file:')) {
    if (!transport.readLocal) throw new Error('A local file reader or desktop relay is required')
    return JSON.parse(await transport.readLocal(url)) as unknown
  }
  const result = await (transport.fetch ?? fetch)(url, { signal: AbortSignal.timeout(8000) })
  if (!result.ok) throw new Error(`Catalog source returned HTTP ${result.status}`)
  return result.json() as Promise<unknown>
}

export async function loadAtomicModelCatalog(
  overrides: AtomicSourceOverrides = {},
  transport: AtomicDocumentTransport = {}
) {
  const source = documentUrl(overrides.ATOMIC_MODEL_CATALOG_URL ?? ATOMIC_MODEL_CATALOG_URL)
  return parseAtomicModelCatalog(await readAtomicDocument(source, transport), {
    allowCandidates: source !== ATOMIC_MODEL_CATALOG_URL,
  })
}
