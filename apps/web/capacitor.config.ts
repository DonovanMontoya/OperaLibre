import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.operalibre.mobile",
  appName: "OperaLibre",
  webDir: "dist",
  backgroundColor: "#f1e7d0",
  // Bridge payloads now include transient provider passwords and signed URLs.
  // Never emit automatic native bridge payload logging, including debug builds.
  loggingBehavior: "none",
  // Adding App solely for gift URL delivery must not change Android Back.
  plugins: { App: { disableBackButtonHandler: true } },
  android: {
    allowMixedContent: true,
    backgroundColor: "#f1e7d0"
  },
  ios: {
    backgroundColor: "#f1e7d0",
    contentInset: "never",
    preferredContentMode: "mobile",
    allowsLinkPreview: false
  }
};

export default config;
