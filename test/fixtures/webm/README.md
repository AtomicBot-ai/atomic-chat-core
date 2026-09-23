# WebM fixture

`tiny.webm` stands in for what `sd-server` returns from `POST /sdcpp/v1/vid_gen`: VP8 frames muxed
into WebM, which is how stable-diffusion.cpp writes video (libwebp for the frames, libwebm for the
container). It was produced by an independent encoder, not by anything in this repository:

```
ffmpeg -f lavfi -i color=c=red:s=64x64:r=24:d=0.25 -c:v libvpx -b:v 50k -an tiny.webm
```

- ffmpeg 8.1 (Homebrew, macOS), 2026-09-23
- 64×64, 24 fps, 6 frames, no audio track, 691 bytes
- sha256 `bc2408a6eb89a9dd484f0ea1f914a62f3d8a0f2e20d0fe03cceef1695954b754`

The core never decodes video (no codec dependency, AGENTS.md rule 8); it checks the EBML magic and
the `DocType`, writes the bytes as they came, and the tests compare what was saved with this file.
