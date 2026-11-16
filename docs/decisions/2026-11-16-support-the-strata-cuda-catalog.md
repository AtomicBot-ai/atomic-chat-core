# Support the Strata CUDA catalog

Strata 0.1.59 exposes 35 model and quantization choices on x64 CUDA 13. CUDA 12 omits the seven DeepSeek choices because Atomic Chat's CUDA 12 bundle has no DeepSeek engine.

The optional `strata-cuda-models` collection uses its own entry kind. Earlier clients eagerly validate every entry of the original Strata kind and do not recognize the extra layouts. Current clients validate and combine both collections. The original six entries remain readable by the earlier client.

Core owns the selection of local tools and engine arguments. Multi-shard GGUFs may have a metadata-only first shard. DeepSeek's separate Engram may be the last shard in a split and is included in the same geometry check. The Q8 Unsloth DeepSeek recipe carries the table with its weights. NVFP4 uses the ready pack, separate dense, PLE and embedding files, and a receipt tied to the source digest; it does not duplicate the weights in the preparation cache. NVFP4-QAD pins the published hardhant conversion of NVIDIA's original QAD checkpoint, which provides the Strata pack without adding Python dependencies. Its BF16 PLE increases the download size. NVFP4 and Swift/Coder are wired without a separate speculative draft pack.
