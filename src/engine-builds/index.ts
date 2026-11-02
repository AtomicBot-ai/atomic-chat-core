/**
 * Engine builds the core downloads, checks, activates and removes itself, from conf's manifests
 * (openspec change `move-sdcpp-mlx-install-to-core`): sd.cpp, audio.cpp, MLX, Foundry Local,
 * LiteRT-LM and GenieX.
 */
export * from './manifest.js'
export * from './order.js'
export * from './select.js'
export * from './builds.js'
export * from './install.js'
export * from './service.js'
