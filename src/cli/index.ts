/**
 * Public API of the CLI module: the owner model (find or start the core that owns a data folder)
 * and the injectable I/O every command runs against. The command dispatcher (`main.ts`) and the
 * commands themselves stay internal — a host reuses the mechanics, not the command surface.
 */
export * from './owner.js'
export * from './io.js'
