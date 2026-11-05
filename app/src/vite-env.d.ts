/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Адрес сервера по умолчанию, вшивается при сборке установщика. */
  readonly VITE_DEFAULT_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
