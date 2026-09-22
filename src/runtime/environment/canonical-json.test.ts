import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { BeginOperation } from '../../contracts/index.js'
import {
  beginFingerprint,
  canonicalDigest,
  canonicalJson,
  planDigest,
  type PlanFingerprint,
} from './canonical-json.js'

const codeOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    if (error instanceof AtomicCoreError) return error.code
    throw error
  }
  throw new Error('expected a throw')
}

describe('canonicalJson', () => {
  it('spells an object the same however its keys were ordered, all the way down', () => {
    const one = { b: 1, a: { d: [1, 2], c: 'x' } }
    const other = { a: { c: 'x', d: [1, 2] }, b: 1 }

    expect(canonicalJson(one)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}')
    expect(canonicalJson(one)).toBe(canonicalJson(other))
    expect(canonicalDigest(one)).toBe(canonicalDigest(other))
  })

  it('keeps array order, because a list in another order is another value', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
    expect(canonicalDigest(['Install docker-ce', 'Add u to docker'])).not.toBe(
      canonicalDigest(['Add u to docker', 'Install docker-ce'])
    )
  })

  it('treats a property set to undefined as a property that is not there', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalDigest({ a: 1, b: undefined })).toBe(canonicalDigest({ a: 1 }))
  })

  it('refuses every value JSON would quietly change into another one', () => {
    // `JSON.stringify` turns each of these into `null` or drops it, which would let two different
    // plans share a hash. A hash that backs a privileged install may not be approximate.
    expect(codeOf(() => canonicalJson([undefined]))).toBe('MANAGED_METADATA_INVALID')
    expect(codeOf(() => canonicalJson(Number.NaN))).toBe('MANAGED_METADATA_INVALID')
    expect(codeOf(() => canonicalJson(Number.POSITIVE_INFINITY))).toBe('MANAGED_METADATA_INVALID')
    expect(codeOf(() => canonicalJson(undefined))).toBe('MANAGED_METADATA_INVALID')
    expect(codeOf(() => canonicalJson({ a: 1n }))).toBe('MANAGED_METADATA_INVALID')
    expect(codeOf(() => canonicalJson({ a: () => 1 }))).toBe('MANAGED_METADATA_INVALID')
    expect(codeOf(() => canonicalJson({ a: Symbol('s') }))).toBe('MANAGED_METADATA_INVALID')
    // A Date walks as `{}` and a Map as `{}` too: both would hash as an empty object.
    expect(codeOf(() => canonicalJson({ at: new Date(0) }))).toBe('MANAGED_METADATA_INVALID')
    expect(codeOf(() => canonicalJson({ m: new Map([['a', 1]]) }))).toBe('MANAGED_METADATA_INVALID')
  })

  it('names the offending path, so a rejected descriptor can be fixed', () => {
    try {
      canonicalJson({ image: { sizes: [1, Number.NaN] } })
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as AtomicCoreError).message).toContain('$.image.sizes[1]')
    }
  })

  it('hashes a fixed value to a fixed digest, so the algorithm cannot drift unnoticed', () => {
    // The canonical form is `{"a":1,"b":"x"}`; the digest below is that string through
    // `shasum -a 256`, computed outside this code so the test cannot agree with a bug.
    expect(canonicalJson({ b: 'x', a: 1 })).toBe('{"a":1,"b":"x"}')
    expect(canonicalDigest({ b: 'x', a: 1 })).toBe(
      'sha256:ecf9e98ec0641e23113ff3ce8bdc78d0ddd249886517fd4a7f68cc83d4e65667'
    )
  })
})

describe('beginFingerprint', () => {
  const base: BeginOperation = {
    request_id: 'req-1',
    target: { kind: 'runtime', installation_id: 'inst-1', engine_id: 'tensorrt-llm' },
    kind: 'setup',
    descriptor_id: 'trtllm-1.3.0rc27',
  }

  it('ignores the request id and the approval, which are not what the request means', () => {
    // A client that retries with a fresh id must not look like a different install; an approval
    // arrives later, on resume, and may legitimately change without changing the request.
    expect(beginFingerprint({ ...base, request_id: 'req-2' })).toBe(beginFingerprint(base))
    expect(beginFingerprint({ ...base, approved_plan_digest: 'sha256:aa' })).toBe(beginFingerprint(base))
  })

  it('treats an absent retain_models as the default it stands for', () => {
    expect(beginFingerprint({ ...base, retain_models: false })).toBe(beginFingerprint(base))
    expect(beginFingerprint({ ...base, retain_models: true })).not.toBe(beginFingerprint(base))
  })

  it('separates a different descriptor, kind or target', () => {
    expect(beginFingerprint({ ...base, descriptor_id: 'trtllm-1.4.0' })).not.toBe(beginFingerprint(base))
    expect(beginFingerprint({ ...base, kind: 'remove' })).not.toBe(beginFingerprint(base))
    expect(beginFingerprint({ ...base, target: { kind: 'environment' } })).not.toBe(beginFingerprint(base))
    // Same engine, other installation: still a different thing to install.
    expect(
      beginFingerprint({
        ...base,
        target: { kind: 'runtime', installation_id: 'inst-2', engine_id: 'tensorrt-llm' },
      })
    ).not.toBe(beginFingerprint(base))
  })
})

describe('planDigest', () => {
  const plan: PlanFingerprint = {
    target: { kind: 'environment' },
    recipe_id: 'ubuntu-24.04-docker-ce',
    recipe_digest: 'sha256:aa',
    adopts_existing_engine: false,
    system_changes: ['Install docker-ce', 'Install nvidia-container-toolkit'],
    requires_elevation: true,
    may_require_relogin: true,
    may_require_reboot: false,
    descriptor: {
      descriptor_id: 'trtllm-1.3.0rc27',
      image_digest: 'sha256:bb',
      entrypoint_digest: 'sha256:cc',
    },
  }

  it('changes when the system changes do, including only their order', () => {
    expect(planDigest({ ...plan, system_changes: [...plan.system_changes].reverse() })).not.toBe(
      planDigest(plan)
    )
    expect(planDigest({ ...plan, system_changes: [...plan.system_changes, 'Add u to docker'] })).not.toBe(
      planDigest(plan)
    )
  })

  it('changes when the recipe, the image or the entrypoint script changes', () => {
    expect(planDigest({ ...plan, recipe_digest: 'sha256:zz' })).not.toBe(planDigest(plan))
    expect(planDigest({ ...plan, descriptor: { ...plan.descriptor!, image_digest: 'sha256:zz' } })).not.toBe(
      planDigest(plan)
    )
    expect(
      planDigest({ ...plan, descriptor: { ...plan.descriptor!, entrypoint_digest: 'sha256:zz' } })
    ).not.toBe(planDigest(plan))
  })

  it('separates a plan that installs nothing from one that installs the runtime', () => {
    // Adopting the host's working Docker asks for no privilege at all; consenting to that is not
    // consenting to a package install.
    expect(
      planDigest({
        ...plan,
        adopts_existing_engine: true,
        system_changes: [],
        requires_elevation: false,
        may_require_relogin: false,
      })
    ).not.toBe(planDigest(plan))
  })

  it('is stable for the same plan, whatever order its fields were built in', () => {
    const rebuilt: PlanFingerprint = {
      descriptor: plan.descriptor,
      may_require_reboot: plan.may_require_reboot,
      may_require_relogin: plan.may_require_relogin,
      requires_elevation: plan.requires_elevation,
      system_changes: [...plan.system_changes],
      adopts_existing_engine: plan.adopts_existing_engine,
      recipe_digest: plan.recipe_digest,
      recipe_id: plan.recipe_id,
      target: plan.target,
    }
    expect(planDigest(rebuilt)).toBe(planDigest(plan))
  })
})
