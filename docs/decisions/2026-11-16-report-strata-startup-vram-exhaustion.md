# Report confirmed Strata startup VRAM exhaustion

Strata Control reports a failed readiness state even when its compute process wrote a precise GPU allocation failure to the launch log. The generic load error loses the distinction between a model that cannot fit and an engine fault.

After a startup failure, inspect a bounded tail of the log for that generation. Explicit VRAM exhaustion and CUDA allocation failures use the existing OUT_OF_MEMORY code. If the engine reports the required and free amounts, include those numbers in the details. Preserve the original error for an absent or inconclusive log. Cancellation, timeout, and process cleanup keep their existing behavior.

The app can use its existing memory error and recovery hints. The bounded reader and numeric details avoid forwarding paths and unrelated log content.
