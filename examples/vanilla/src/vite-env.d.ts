/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
  readonly VITE_REMOTE_CORE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
