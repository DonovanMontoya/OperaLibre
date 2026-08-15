/// <reference types="vite/client" />

declare const __OPERALIBRE_FRONTEND_VERSION__: string;

interface Window {
  // Injected by apps/macos before any page script runs; see main.swift.
  readonly __OPERALIBRE_NATIVE_SHELL__?: boolean;
}
