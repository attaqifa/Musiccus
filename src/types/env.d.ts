/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL prefix (ending in /) for ONNX Runtime's .mjs and .wasm files (default: jsDelivr, same version as installed). */
  readonly VITE_ORT_BASE?: string;
  /** Base URL of the htdemucs model pieces (default: the pinned Hugging Face commit). */
  readonly VITE_MODEL_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
