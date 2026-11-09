---
date: 2026-11-05
title: "Build and verify the same local FastFlowLM model configuration"
---

# Build and verify the same local FastFlowLM model configuration

Desktop and server installers share a pure builder from the browser-safe client. It emits a single checkpoint, resolves its variant directory once under `FLM_MODEL_PATH`, and puts the installer's pinned file sizes and hashes in the native inventory. A check regenerates both documents from the committed marker, then verifies the files themselves. This permits offline validation even if conf has published a newer model. The cost of resolving a committed variant is a full read of its weights.

The native catalog also supplies launch parameters that the upstream engine reads directly. For instance Qwen3 uses the parameter count to select its reasoning behavior. Its native format floor is 0.9.22 even though the required Atomic engine build is flm-1.0.11-r1. Substituting the build version for the model format floor would reject a valid installation. The bundled profiles select native fields from `src/model_list.json` at FastFlowLM commit `f37cdd29edc777cf3db1e385da8e7bfadc57d0b3` and include the required payload filenames from the corresponding staging plans. Weights, kernel hashes, download origins and production qualification remain in conf. A new checkpoint needs a reviewed native profile before this core can validate it.
