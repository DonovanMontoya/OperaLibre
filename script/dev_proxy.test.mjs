import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { devProxyTarget, devServerEnvironment, repositoryRoot } from "./dev_proxy.mjs";
import { browserApiBase } from "../apps/web/src/serverAddress.ts";

async function fixture(t, contents) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "operalibre-dev-proxy-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (contents !== undefined) await writeFile(path.join(root, "server.config"), contents);
  return root;
}

test("legacy saved localhost:4000 uses the proxy targeting the retained config port", async (t) => {
  const root = await fixture(t, "port = 4000\n");
  assert.equal(browserApiBase("http://localhost:4000", "http://localhost:5173"), "http://localhost:5173");
  assert.equal(devProxyTarget({}, root), "http://127.0.0.1:4000");
});

test("config port wins over PORT and accepts Rust config quoting and duplicate keys", async (t) => {
  const root = await fixture(t, "# old settings\r\nport = 4920\r\n PORT = ' +04000 '\r\n");
  assert.equal(devProxyTarget({ PORT: "invalid" }, root), "http://127.0.0.1:4000");
});

test("absent and empty config ports use PORT then the new default", async (t) => {
  for (const contents of [undefined, "port = \" \"\n"]) {
    const root = await fixture(t, contents);
    assert.equal(devProxyTarget({}, root), "http://127.0.0.1:4920");
    assert.equal(devProxyTarget({ PORT: " 4000 " }, root), "http://127.0.0.1:4000");
    assert.equal(devProxyTarget({ PORT: " " }, root), "http://127.0.0.1:4920");
  }
});

test("explicit config paths stay identical across server and npm workspace directories", async (t) => {
  const root = await fixture(t, "port = 4920\n");
  await writeFile(path.join(root, "custom.config"), "port = 4000\n");
  const env = devServerEnvironment({ OPERALIBRE_SERVER_CONFIG: "custom.config", PORT: "4999" }, root);
  assert.equal(env.OPERALIBRE_SERVER_CONFIG, path.join(root, "custom.config"));
  assert.equal(env.PORT, "4999");
  assert.equal(devProxyTarget(env, root), "http://127.0.0.1:4000");
  assert.equal(devProxyTarget(env, path.join(root, "apps", "web")), "http://127.0.0.1:4000");
  assert.equal(devProxyTarget({ OPERALIBRE_SERVER_CONFIG: "custom.config" }, root), "http://127.0.0.1:4000");
  assert.deepEqual(devServerEnvironment({}, root), {});
});

test("dev launcher passes the same resolved config and environment to both children", async (t) => {
  const root = await fixture(t);
  const preload = path.join(root, "spawn.mjs");
  await writeFile(preload, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
childProcess.spawn = (command, args, options) => {
  console.log(JSON.stringify({ command, args, cwd: options.cwd, config: options.env.OPERALIBRE_SERVER_CONFIG, port: options.env.PORT }));
  return { exitCode: null, on() {}, kill() {} };
};
syncBuiltinESMExports();
`);
  const output = execFileSync(process.execPath, ["--import", preload, path.join(repositoryRoot, "script/dev.mjs")], {
    cwd: root,
    env: { ...process.env, OPERALIBRE_SERVER_CONFIG: "custom.config", PORT: "4000", npm_execpath: "npm-cli.js" },
    encoding: "utf8"
  });
  const children = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(children.length, 2);
  assert.equal(children[0].command, "cargo");
  assert.equal(children[1].command, process.execPath);
  for (const child of children) {
    assert.equal(child.cwd, repositoryRoot);
    assert.equal(child.config, path.join(root, "custom.config"));
    assert.equal(child.port, "4000");
  }
});

test("missing explicit config and malformed ports fail instead of silently using 4920", async (t) => {
  const root = await fixture(t);
  assert.throws(() => devProxyTarget({ OPERALIBRE_SERVER_CONFIG: "missing.config" }, root), /ENOENT/);
  for (const port of ["4000oops", "-1", "65536", "4e3", "4000 # old port"]) {
    assert.throws(() => devProxyTarget({ PORT: port }, root), /Invalid development server port/);
    await writeFile(path.join(root, "server.config"), `port = ${port}\n`);
    assert.throws(() => devProxyTarget({ PORT: "4920" }, root), /Invalid development server port/);
    await rm(path.join(root, "server.config"));
  }
});

test("Vite forwards requests and cookie write headers to the effective config port", async (t) => {
  const { createServer } = await import("vite");
  const backend = createHttpServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ url: request.url, method: request.method, headers: request.headers }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => new Promise((resolve, reject) => backend.close((error) => error ? reject(error) : resolve())));
  const port = backend.address().port;
  const root = await fixture(t, `host = 127.0.0.1\nport = ${port}\n`);
  const previous = process.env.OPERALIBRE_SERVER_CONFIG;
  process.env.OPERALIBRE_SERVER_CONFIG = path.join(root, "server.config");
  t.after(() => {
    if (previous === undefined) delete process.env.OPERALIBRE_SERVER_CONFIG;
    else process.env.OPERALIBRE_SERVER_CONFIG = previous;
  });
  const vite = await createServer({
    root: path.join(repositoryRoot, "apps/web"),
    configFile: path.join(repositoryRoot, "apps/web/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, watch: null },
    logLevel: "silent"
  });
  t.after(() => vite.close());
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const target = `http://127.0.0.1:${port}`;
  assert.equal(vite.config.server.proxy["/api"].target, target);
  const response = await fetch(`${origin}/api/health?regression=4000`, {
    method: "POST",
    headers: { Origin: origin, Referer: `${origin}/library`, Cookie: "session=test" }
  });
  assert.equal(response.status, 200);
  const received = await response.json();
  assert.equal(received.url, "/api/health?regression=4000");
  assert.equal(received.method, "POST");
  assert.equal(received.headers.host, `127.0.0.1:${port}`);
  assert.equal(received.headers.origin, target);
  assert.equal(received.headers.referer, `${target}/`);
  assert.equal(received.headers.cookie, "session=test");
  const plain = await (await fetch(`${origin}/api/health`)).json();
  assert.equal(plain.headers.origin, undefined);
  assert.equal(plain.headers.referer, undefined);
});

test("production config does not require a local server config", async (t) => {
  const { loadConfigFromFile } = await import("vite");
  const root = await fixture(t);
  const previous = process.env.OPERALIBRE_SERVER_CONFIG;
  process.env.OPERALIBRE_SERVER_CONFIG = path.join(root, "missing.config");
  t.after(() => {
    if (previous === undefined) delete process.env.OPERALIBRE_SERVER_CONFIG;
    else process.env.OPERALIBRE_SERVER_CONFIG = previous;
  });
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    path.join(repositoryRoot, "apps/web/vite.config.ts")
  );
  assert.equal(loaded.config.base, "./");
});

test("proxy connects to the configured host and maps wildcard binds to loopback", async (t) => {
  const root = await fixture(t, "host = 127.0.0.2\nport = 4000\n");
  assert.equal(devProxyTarget({ HOST: "127.0.0.3" }, root), "http://127.0.0.2:4000");
  await writeFile(path.join(root, "server.config"), "host =\nport = 4000\n");
  for (const [host, target] of [["0.0.0.0", "127.0.0.1"], ["::", "[::1]"], ["::1", "[::1]"]]) {
    assert.equal(devProxyTarget({ HOST: host }, root), `http://${target}:4000`);
  }
});
