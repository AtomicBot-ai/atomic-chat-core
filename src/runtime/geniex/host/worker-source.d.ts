/**
 * The shape of `worker-source.generated.ts`, which `scripts/build-geniex-worker.mjs` writes before a
 * build and git does not carry: a checkout without a build still typechecks `engine.ts`, whose
 * dynamic import of the module runs only inside a compiled binary.
 */
declare module '*/worker-source.generated.js' {
  /** The Worker's script: `worker.ts` and its imports, one bundle. */
  export const GENIEX_WORKER_SOURCE: string
}
