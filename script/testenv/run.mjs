// Runs this checkout against a long-lived test environment: a generated
// library, an owner and a reader with fixed passwords, and fake Audible and
// Libro.fm stores. The environment is built on first use and kept between
// runs, so sign-ins and test state carry over until --reset rebuilds it.
//
//   npm run testenv                    already signed in as the owner
//   npm run testenv -- --as reader     already signed in as the reader
//   npm run testenv -- --login         sign in as usual
//   npm run testenv -- --reset         rebuild the environment from scratch
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../dev_proxy.mjs";
import {
  AUDIBLE_UK, AUDIBLE_US, audible, libro, libroAccounts, library
} from "./catalog.mjs";

const SERVER_PORT = 4957;
const WEB_PORT = 5197;
// localhost rather than 127.0.0.1: browsers share cookies across ports on one
// host, so this keeps the test sign-in apart from a real server on 127.0.0.1.
const WEB_URL = `http://localhost:${WEB_PORT}`;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const PASSWORD = "operalibre-test";
const USERS = { owner: "owner", reader: "reader" };

const { values: options } = parseArgs({
  options: {
    reset: { type: "boolean", default: false },
    login: { type: "boolean", default: false },
    as: { type: "string" }
  }
});
if (options.as !== undefined && !(options.as in USERS)) {
  fail(`--as takes ${Object.keys(USERS).join(" or ")}.`);
}
if (options.as !== undefined && options.login) fail("--as and --login cannot be combined.");
const signedInAs = options.login ? null : options.as ?? "owner";

// `||` so an empty variable falls back too, instead of resolving to the
// current directory.
const home = path.resolve(process.env.OPERALIBRE_TESTENV_DIR || path.join(homedir(), ".operalibre-testenv"));
// Written first into every environment this script builds, so a rebuild only
// ever deletes a folder it made. The name and contents differ from the
// default folder's, which a parent folder such as ~ would otherwise pass for.
const MARKER = "operalibre-testenv.marker";
const MARKER_CONTENTS = "OperaLibre test environment\n";
const file = (...parts) => path.join(home, ...parts);
const webRequire = createRequire(path.join(repositoryRoot, "apps/web/package.json"));

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function serverReady() {
  return fetch(`${SERVER_URL}/api/health`).then((response) => response.json()).then((health) => health.ready === true, () => false);
}

async function api(route, { method = "GET", token, body } = {}) {
  const response = await fetch(SERVER_URL + route, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function until(check, what) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: repositoryRoot });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed.`);
}

// Square covers with the title and author set on the book's colour, drawn in
// the browser the lifecycle tests already use. Without one, plain colour.
// Each book names the image file to write.
async function drawCovers(books) {
  let browser;
  try {
    const playwright = await import(pathToFileURL(webRequire.resolve("@playwright/test")).href);
    browser = await (playwright.chromium ?? playwright.default.chromium).launch();
  } catch {
    console.log("Playwright's Chromium is unavailable, so covers will be plain colour.");
  }
  const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const page = await browser?.newPage({ viewport: { width: 600, height: 600 } });
  for (const { title, author, colour, cover } of books) {
    await mkdir(path.dirname(cover), { recursive: true });
    if (page) {
      const red = parseInt(colour.slice(1, 3), 16);
      const green = parseInt(colour.slice(3, 5), 16);
      const blue = parseInt(colour.slice(5, 7), 16);
      const ink = red + green + blue > 480 ? "#2a2420" : "#f3e6cc";
      await page.setContent(`<body style="margin:0"><div style="box-sizing:border-box;width:600px;height:600px;background:${colour};padding:56px 52px;display:flex;flex-direction:column;justify-content:space-between;color:${ink}">
        <div style="font:italic 64px/1.05 Georgia,serif">${escape(title)}</div>
        <div style="font:500 22px Georgia,serif;letter-spacing:.18em;text-transform:uppercase;opacity:.85">${escape(author)}</div></div></body>`);
      await page.screenshot({ path: cover });
    } else {
      run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x${colour.slice(1)}:s=600x600`, "-frames:v", "1", cover]);
    }
  }
  await browser?.close();
}

// Two short chapters of quiet tone per book, tagged the way audiobook rips
// are, with the cover embedded.
async function buildLibrary() {
  console.log(`Generating ${library.length} audiobooks…`);
  const books = library.map(([title, author, narrator, genre, , , colour], index) => ({
    title, author, narrator, genre, colour, cover: file("covers", `${index}.png`)
  }));
  await drawCovers(books);
  for (const [index, book] of books.entries()) {
    const folder = file("library", book.author, book.title);
    await mkdir(folder, { recursive: true });
    for (const chapter of [1, 2]) {
      run("ffmpeg", [
        "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", `sine=frequency=${180 + chapter * 40}:duration=${150 + (index * 37 + chapter * 23) % 120}`,
        "-i", book.cover,
        "-map", "0:a", "-map", "1:v", "-af", "volume=0.05", "-ac", "1", "-ar", "22050", "-b:a", "24k",
        "-c:v", "png", "-disposition:v", "attached_pic", "-id3v2_version", "3",
        "-metadata", `title=Chapter ${chapter}`, "-metadata", `album=${book.title}`,
        "-metadata", `artist=${book.author}`, "-metadata", `album_artist=${book.author}`,
        "-metadata", `composer=${book.narrator}`, "-metadata", `genre=${book.genre}`,
        "-metadata", `track=${chapter}/2`,
        path.join(folder, `0${chapter}.mp3`)
      ]);
    }
  }
}

// Get books: a stand-in for the Libation CLI with two Audible accounts, and
// Libro.fm account files the server reads per user.
async function buildStores() {
  const asin = (index) => `B0FAKE${String(index + 1).padStart(4, "0")}`;
  const coverId = (index) => `fakeCover${String(index + 1).padStart(2, "0")}`;
  // The server serves covers from Libation's Images folder by this name.
  await drawCovers(audible.map(([, title, , authors, , , , , colour], index) => ({
    title, author: authors.split(",")[0], colour, cover: file("libation", "Images", `${coverId(index)}_500x500.jpg`)
  })));
  await writeFile(file("libation-export.json"), JSON.stringify(audible.map(
    ([account, title, subtitle, authors, narrators, minutes, publisher, liberated, , plus], index) => ({
      "Account": account,
      "Locale": account === AUDIBLE_UK ? "uk" : "us",
      "Audible Product Id": asin(index),
      "Title": title,
      "Subtitle": subtitle || null,
      "Authors": authors,
      "Narrators": narrators,
      "Length In Minutes": minutes,
      "Description": `A made-up Audible listing of ${title}.`,
      "Publisher": publisher,
      "Book Liberated Status": liberated ? "Liberated" : "NotLiberated",
      "PDF Liberated Status": null,
      "Content Type": "Product",
      "Last Downloaded": liberated ? "2026-09-01T12:00:00Z" : null,
      "Is Audible Plus?": !!plus,
      "Cover Id": coverId(index),
      "Cover Id Large": null
    })
  ), null, 2));
  // Every other Libation command (scan, liberate) succeeds without doing anything.
  const cli = file("fake-libation.sh");
  await writeFile(cli, `#!/bin/sh
cmd="$1"; shift
case "$cmd" in
  list-accounts)
    printf '${AUDIBLE_US}\\tRowan (US)\\tus\\tyes\\tyes\\n'
    printf '${AUDIBLE_UK}\\tHousehold (UK)\\tuk\\tyes\\tyes\\n'
    ;;
  export)
    while [ $# -gt 0 ]; do [ "$1" = --path ] && out="$2"; shift; done
    cp '${file("libation-export.json")}' "$out"
    ;;
esac
exit 0
`);
  await chmod(cli, 0o755);
}

async function writeLibroAccounts(userId) {
  const accounts = libroAccounts.map(([email, nickname]) => ({
    email, nickname, token: "test-token", synced_at: "2026-10-15T09:00:00Z",
    books: libro.filter((row) => row[0] === email).map(
      ([, isbn, title, authors, narrators, duration, publisher, published, series, position, genre]) => ({
        isbn, title, authors, cover_url: null,
        audiobook_info: { narrators, duration },
        description: `A made-up Libro.fm listing of ${title}.`,
        publisher, publication_date: published,
        series: series || null, series_num: position || null,
        genres: [{ name: genre }]
      })
    )
  }));
  const key = createHash("sha256").update(userId).digest("hex");
  await mkdir(file("data", "libro-accounts"), { recursive: true });
  await writeFile(file("data", "libro-accounts", `${key}.json`), JSON.stringify(accounts, null, 2));
}

async function writeConfig() {
  // The Libation stand-in is a shell script, so Windows goes without Audible.
  const libation = process.platform === "win32" ? [] : [
    `libation_cli_path = ${file("fake-libation.sh")}`,
    `libation_files_dir = ${file("libation")}`
  ];
  await writeFile(file("server.config"), [
    "deployment_mode = local",
    "host = 127.0.0.1",
    `port = ${SERVER_PORT}`,
    `library_root = ${file("library")}`,
    `data_dir = ${file("data")}`,
    "web_dist_dir =",
    "libation_auto_refresh_hours = 0",
    ...libation,
    ""
  ].join("\n"));
}

// Accounts, series, and a couple of the reader's Audible requests waiting for
// the owner's approval.
async function seed() {
  const owner = await api("/api/auth/setup", { method: "POST", body: { username: USERS.owner, password: PASSWORD } });
  const reader = await api("/api/users", {
    method: "POST",
    token: owner.token,
    body: { username: USERS.reader, password: PASSWORD, libationAccess: "approval" }
  });
  await until(async () => (await api("/api/books", { token: owner.token })).length >= library.length, "the library scan");
  const books = await api("/api/books", { token: owner.token });
  for (const [title, author, narrator, genre, series, position] of library) {
    const book = books.find((candidate) => candidate.title === title);
    if (!series || !book) continue;
    await api(`/api/books/${encodeURIComponent(book.id)}/metadata`, {
      method: "PUT",
      token: owner.token,
      body: {
        title, author, narrator, description: null, genres: [genre], publishedDate: null,
        publisher: null, series, seriesPosition: position, asin: null
      }
    });
  }
  await writeLibroAccounts(owner.user.id);
  await writeLibroAccounts(reader.id);
  if (process.platform !== "win32") {
    const signedIn = await api("/api/auth/login", { method: "POST", body: { username: USERS.reader, password: PASSWORD } });
    const listings = await api("/api/libation/books", { token: signedIn.token });
    for (const title of ["The Way of Kings", "Children of Time"]) {
      const listing = listings.find((candidate) => candidate.title === title);
      if (!listing) continue;
      await api(`/api/libation/requests/${encodeURIComponent(listing.asin)}`, {
        method: "POST",
        token: signedIn.token,
        body: { title, profileId: listing.profileId }
      });
    }
    await api("/api/auth/logout", { method: "POST", token: signedIn.token });
  }
}

// Reuses the saved session for a user while the server still honours it, so
// each run does not pile up a new session.
async function sessionToken(user) {
  const saved = JSON.parse(await readFile(file("sessions.json"), "utf8").catch(() => "{}"));
  if (saved[user]) {
    const status = await api("/api/auth/status", { token: saved[user] }).catch(() => null);
    if (status?.user?.username === USERS[user]) return saved[user];
  }
  const signedIn = await api("/api/auth/login", { method: "POST", body: { username: USERS[user], password: PASSWORD } });
  saved[user] = signedIn.token;
  await writeFile(file("sessions.json"), JSON.stringify(saved, null, 2));
  return signedIn.token;
}

// One run at a time per environment. The lock covers the minutes of a first
// build, before the server answers, and survives the rebuild that follows.
const LOCK = "testenv.lock";
const lock = file(LOCK);
const readText = (target) => {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
};
function lockedByAnother() {
  const pid = Number(readText(lock));
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const alreadyRunning = `A test environment is already running at ${WEB_URL}. Stop it first (Ctrl-C in its terminal).`;
if (await serverReady()) fail(alreadyRunning);
await mkdir(home, { recursive: true });
try {
  writeFileSync(lock, String(process.pid), { flag: "wx" });
} catch {
  // A lock left by a run that has since exited is taken over.
  if (lockedByAnother()) fail(alreadyRunning);
  writeFileSync(lock, String(process.pid));
}
process.on("exit", () => {
  if (readText(lock) === String(process.pid)) unlinkSync(lock);
});
// An environment whose first build never finished is rebuilt too.
const fresh = options.reset || !existsSync(file(".ready"));
if (fresh) {
  const contents = readdirSync(home).filter((name) => name !== LOCK);
  if (contents.length > 0 && readText(file(MARKER)) !== MARKER_CONTENTS) {
    fail(`${home} is not a test environment this script built, so it was left alone. Set OPERALIBRE_TESTENV_DIR to a new or empty folder.`);
  }
  await Promise.all(contents.map((name) => rm(file(name), { recursive: true, force: true })));
  await writeFile(file(MARKER), MARKER_CONTENTS);
  await buildLibrary();
  if (process.platform !== "win32") await buildStores();
  await writeConfig();
}

// Cargo reports where it put the binary, wherever its target directory is
// configured to be.
console.log("Building the server…");
const build = spawnSync("cargo", ["build", "--quiet", "--message-format=json-render-diagnostics", "--manifest-path", "apps/server/Cargo.toml"], {
  cwd: repositoryRoot,
  stdio: ["ignore", "pipe", "inherit"],
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024
});
if (build.error) throw build.error;
if (build.status !== 0) fail("cargo build failed.");
const serverBinary = build.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  .find((message) => message.reason === "compiler-artifact" && message.target?.name === "operalibre-server" && message.executable)?.executable;
if (!serverBinary) fail("cargo build did not report the server binary.");
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("OPERALIBRE_") && !key.startsWith("LIBATION_")));
environment.OPERALIBRE_SERVER_CONFIG = file("server.config");

const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
function supervise(child, name) {
  children.push(child);
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`The ${name} stopped (${code ?? "signal"}).`);
      stop(code || 1);
    }
  });
  return child;
}

const serverLog = createWriteStream(file("server.log"), { flags: "a" });
const server = supervise(spawn(serverBinary, [], {
  cwd: home,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"]
}), "server");
server.stdout.pipe(serverLog);
server.stderr.pipe(serverLog);

try {
  await until(async () => {
    if (stopping) throw new Error(`The server could not start; see ${file("server.log")}.`);
    return serverReady();
  }, "the server");
  if (fresh) {
    console.log("Setting up accounts and stores…");
    await seed();
    await writeFile(file(".ready"), "");
  }
  if (signedInAs) environment.OPERALIBRE_DEV_SESSION_TOKEN = await sessionToken(signedInAs);
} catch (error) {
  console.error(error.message);
  stop(1);
}

if (!stopping) {
  const vite = path.join(path.dirname(webRequire.resolve("vite/package.json")), "bin", "vite.js");
  supervise(spawn(process.execPath, [vite, "--host", "localhost", "--port", String(WEB_PORT), "--strictPort", "--clearScreen", "false"], {
    cwd: path.join(repositoryRoot, "apps/web"),
    env: environment,
    stdio: ["ignore", "inherit", "inherit"]
  }), "web dev server");
  console.log(`
  Test environment: ${WEB_URL}
  ${signedInAs ? `Signed in as ${USERS[signedInAs]}.` : "Sign in with either account:"}
    owner  / ${PASSWORD}
    reader / ${PASSWORD}   (asks the owner before getting Audible books)
  Data: ${home}   Server log: ${file("server.log")}
  Ctrl-C stops it. --login signs in as usual; --reset rebuilds everything.
`);
}
