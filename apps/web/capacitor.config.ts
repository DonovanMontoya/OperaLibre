import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.operalibre.mobile",
  appName: "OperaLibre",
  webDir: "dist",
  backgroundColor: "#f1e7d0",
  loggingBehavior: "production",
  ios: {
    backgroundColor: "#f1e7d0",
    contentInset: "never",
    preferredContentMode: "mobile",
    allowsLinkPreview: false
  }
};

export default config;
