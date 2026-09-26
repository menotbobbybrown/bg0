# @bg0/browser

Remove image backgrounds locally in the browser with WebGPU or WebAssembly.
Images stay on the device, and no API key or server is required.

## Install

```bash
npm install @bg0/browser
```

Transformers.js 4.3.0 stops loading models in a page after one ONNX load
fails. bg0.dev applies [a small patch](https://github.com/opencoredev/bg0/blob/main/patches/%40huggingface%252Ftransformers%404.3.0.patch) so it can fall back to
WebAssembly or retry without a reload. npm does not apply that patch for you.
Without it, a failed load needs a page reload before the next attempt. To match
bg0.dev, pin `@huggingface/transformers` to `4.3.0` and apply the patch with
Bun's `patchedDependencies` or `patch-package`.

## Usage

```ts
import { removeBackground } from '@bg0/browser'

const result = await removeBackground(file, {
  quality: 'quality',
  onProgress: ({ stage, progress, message }) => {
    console.log(stage, progress, message)
  },
})

const url = URL.createObjectURL(result.blob)
```

`file` can be any `Blob`, including a `File` from an input or drop event. PNG,
JPG, WebP, HEIC, and HEIF images up to 60 MB are supported. For a HEIF still
collection, BG0 processes its designated primary image. HEIC/HEIF sequences
are not supported.

The model downloads on the first removal and is cached in browser storage.
WebGPU is preferred when available, with WebAssembly as the compatibility
fallback.

See the [browser library documentation](https://bg0.dev/docs/library) for
options, result fields, errors, capability detection, and cache control.

## License

Apache-2.0. The model weights retain the licenses listed in the repository's
[third-party notices](https://github.com/opencoredev/bg0/blob/main/THIRD_PARTY_NOTICES.md).
