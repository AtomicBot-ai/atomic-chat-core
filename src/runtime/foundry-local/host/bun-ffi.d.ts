/**
 * The part of `bun:ffi` that the hosts' `ffi-bun.ts` use, declared here so the core needs no
 * `@types/bun` (AGENTS.md invariant 8: no new dependency). Only the two `ffi-bun.ts` import this module
 * (operator decision Q2 of change `add-foundry-local`; change `add-litert-lm-runtime`, design D1); they
 * run only inside the compiled binaries, never under Node.
 */
declare module 'bun:ffi' {
  /** A native address, as Bun hands it to JavaScript. */
  export type Pointer = number

  export const FFIType: {
    readonly ptr: number
    readonly u8: number
    readonly u32: number
    readonly i32: number
    readonly i64: number
    readonly u64: number
    readonly f32: number
    readonly f64: number
    readonly bool: number
    readonly void: number
    readonly cstring: number
  }

  export interface FFIFunction {
    readonly args: readonly number[]
    readonly returns: number
  }

  export type NativeArgument = number | bigint | boolean | null | Pointer

  export function dlopen<S extends Record<string, FFIFunction>>(
    path: string,
    symbols: S
  ): { symbols: { [K in keyof S]: (...args: NativeArgument[]) => unknown }; close(): void }

  export function CFunction(
    definition: FFIFunction & { ptr: Pointer }
  ): (...args: NativeArgument[]) => unknown

  export class JSCallback {
    constructor(callback: (...args: never[]) => unknown, definition: FFIFunction & { threadsafe?: boolean })
    readonly ptr: Pointer
    close(): void
  }

  export class CString {
    constructor(pointer: Pointer)
    toString(): string
  }

  export function ptr(view: ArrayBufferView): Pointer

  export const read: {
    ptr(address: Pointer, byteOffset?: number): Pointer
    u8(address: Pointer, byteOffset?: number): number
    u32(address: Pointer, byteOffset?: number): number
  }

  /** Compile C with the TinyCC built into Bun and bind its symbols (LiteRT-LM's chunk shim). */
  export function cc<S extends Record<string, FFIFunction>>(options: {
    source: string
    symbols: S
    flags?: string | string[]
  }): { symbols: { [K in keyof S]: (...args: NativeArgument[]) => unknown }; close(): void }
}
