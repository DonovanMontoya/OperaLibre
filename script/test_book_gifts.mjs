import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

// Disposable frontend only: every broker, peer and native sink in these
// fixtures is local/simulated. No real server config or user library is used.
const requireWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")));
const server = await createServer({
  root: fileURLToPath(new URL("../apps/web", import.meta.url)),
  server: { host: "127.0.0.1", port: 0, strictPort: true },
  logLevel: "error", clearScreen: false,
});
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Gift test server has no local port.");
  const files = ["giftRecipient.browser.mjs", "giftRecoveryPeer.browser.mjs", "giftPersistentTransport.browser.mjs", "giftNativeLinks.browser.mjs", "giftSender.browser.mjs", "giftOwnerSetup.browser.mjs"]
    .map(name => fileURLToPath(new URL(`../apps/web/test/${name}`, import.meta.url)));
  const child = spawn(process.execPath, ["--test", ...files], {
    env: { ...process.env, OPERALIBRE_GIFT_TEST_ORIGIN: `http://127.0.0.1:${address.port}`, OPERALIBRE_GIFT_SCREENSHOT_DIR: fileURLToPath(new URL("../output/book-gifts", import.meta.url)) },
    stdio: "inherit",
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
} finally { await server.close(); }
