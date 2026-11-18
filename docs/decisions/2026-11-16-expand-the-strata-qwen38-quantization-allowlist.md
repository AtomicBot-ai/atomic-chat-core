# Expand the Strata Qwen3.8 quantization allowlist

Q2_0 and IQ3_S use the pinned split Qwen3.8 preparation recipe on Metal and CUDA. IQ2_XS uses that recipe on CUDA. The core keeps an explicit quantization and backend allowlist, and the catalog pins the exact files independently for each quantization. The IQ3_XXS identifier and its preparation cache remain valid for existing installs.
