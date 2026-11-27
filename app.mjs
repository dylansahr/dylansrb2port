import { gameData, modelArchive } from "./game-data.mjs";
import { loadGameData, unpackModels } from "./game-download.mjs";
import { endpoint, engineVersion, normalizeAddress } from "./directory.mjs";
import { createAddonDownload } from "./addon-download.mjs";
import { createTouchControls } from "./touch-controls.mjs";
import { backend, hostedOnPages } from "./backend.mjs";

const byId = id => document.getElementById(id);
const siteTitle = document.title;
// SDL's Emscripten backend uses #canvas to size its drawing surface and map input.
const canvas = byId("canvas");
// SDL's mouse-button event reuses its last motion coordinates. Refresh them
// when the canvas resizes under a stationary pointer before a click.
canvas.addEventListener("mousedown", event => {
  if (document.pointerLockElement === canvas) return;
  canvas.dispatchEvent(new MouseEvent("mousemove", {
    clientX: event.clientX,
    clientY: event.clientY,
    buttons: event.buttons,
  }));
}, { capture: true });

const requestPointerLock = canvas.requestPointerLock?.bind(canvas);
if (requestPointerLock) {
  canvas.requestPointerLock = (...options) => {
    // SDL may request a lock after a map loads. A later click can retry it.
    const attempt = requestPointerLock(...options);
    attempt?.catch(() => {});
    return attempt;
  };
}
const screen = byId("screen");
const viewport = byId("game-viewport");
const stretch = byId("stretch");
const gameNotice = byId("game-notice");
const gameMessage = byId("game-message");
const cancelJoin = byId("cancel-join");
const loader = byId("loader");
const loadStatus = byId("load-status");
const retry = byId("retry");
const downloadProgress = byId("download-progress");
const gameStatus = byId("game-status");
const touch = createTouchControls(screen);
let directoryRequest;
let directoryRows = [];
let directoryIndex = 0;
let directoryResult = 0;
let serverNames = new Map();
let serverDetails = {};
let localRelayRequest;
let relayReady = false;
let runtime;
let resumeGameAudio;
let restartRequired = false;
let running = false;
let loading = false;
let joining = false;
let relayAttempt;
let savegameRetryTarget;
let nextCommand;
let transport;
let syncing;
let syncTimer;
let lastLog = "";
const addonDownload = createAddonDownload(() => transport, () => runtime.FS);
const packetLimit = 1450;
const packetQueueSize = 4096;
const relayStartupTimeout = 85_000;
const relayRetryInterval = 1500;

function setGameStatus(message, error = false) {
  gameStatus.textContent = message;
  gameStatus.classList.toggle("error", error);
  if (!loader.hidden) {
    loadStatus.textContent = message;
    loadStatus.classList.toggle("error", error);
  }
  gameMessage.textContent = message;
  gameMessage.classList.toggle("error", error);
  gameNotice.hidden = !running || (!joining && !error);
}

function fitGame() {
  const { width, height } = canvas;
  if (!running || !width || !height) return;
  const scale = Math.min(viewport.clientWidth / width, viewport.clientHeight / height);
  canvas.style.setProperty("--game-width", `${width * scale}px`);
  canvas.style.setProperty("--game-height", `${height * scale}px`);
}

new ResizeObserver(fitGame).observe(viewport);
new MutationObserver(fitGame).observe(canvas, { attributeFilter: ["width", "height"] });

const stretchPreference = "srb2-stretch";
try {
  if (localStorage.getItem(stretchPreference) === "true") {
    viewport.classList.add("stretched");
    stretch.setAttribute("aria-pressed", "true");
  }
} catch {
  // The setting can still be used when browser storage is unavailable.
}
stretch.addEventListener("click", () => {
  const enabled = viewport.classList.toggle("stretched");
  stretch.setAttribute("aria-pressed", String(enabled));
  try {
    localStorage.setItem(stretchPreference, String(enabled));
  } catch {
    // The current session still keeps the selected display mode.
  }
  canvas.focus({ preventScroll: true });
});
screen.addEventListener("contextmenu", event => event.preventDefault());

// WebKit can allow pinch zoom despite the viewport limits.
for (const type of ["gesturestart", "gesturechange"]) {
  document.addEventListener(type, event => event.preventDefault(), { passive: false });
}
screen.addEventListener("touchmove", event => {
  if (event.touches.length > 1) event.preventDefault();
}, { passive: false });

async function readJson(path, timeout = 10_000) {
  const response = await fetch(new URL(path, backend), {
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The server couldn’t be reached.");
  return body;
}

function getLocalRelay() {
  if (hostedOnPages) return Promise.resolve(null);
  localRelayRequest ??= readJson("/api/local-relay").catch(() => null);
  return localRelayRequest;
}

// The game reads these rows into its existing server browser on the next tic.
function directoryText(value, fallback, maxLength) {
  return (String(value ?? "").replace(/[^\x20-\x7e]/g, "").trim() || fallback).slice(0, maxLength);
}

function publishDirectory(rows, status) {
  serverDetails = status;
  directoryRows = rows;
  directoryIndex = 0;
  directoryResult = 2;
}

function requestServerDirectory() {
  if (directoryRequest) return;
  if (!joining && !transport?.attached) setGameStatus("Ready. Click the game to use the keyboard.");
  const local = getLocalRelay();
  directoryRequest = Promise.all([readJson("/api/servers").catch(() => null), local]).then(async ([directory, config]) => {
    if (!directory && !config?.extraServer) throw new Error("Directory unavailable");
    relayReady = Boolean(config?.available || directory?.statusUrl);
    const rows = (directory?.rooms || []).filter(room => room.id > 0).map(room =>
      ["room", room.id, directoryText(room.name, "Room", 39)].join("\t")
    );
    const servers = directory?.servers || [];
    if (config?.extraServer) servers.unshift(config.extraServer);
    const names = new Map();
    for (const server of servers) {
      const address = normalizeAddress(server.address);
      if (!address || !Number.isInteger(server.port)) continue;
      const target = endpoint(address, server.port);
      const name = directoryText(server.name, target, 63);
      const version = directoryText(server.version, "Unknown", 15);
      names.set(target, name);
      rows.push([version === engineVersion ? "join" : "other", target, server.room ?? 0, version, name].join("\t"));
    }
    serverNames = names;
    // Joining only needs the Master Server listing. Live counts can arrive later.
    publishDirectory(rows, directory?.status || {});
    if (directory?.statusUrl && !directory.status) {
      const relayReport = await readJson(directory.statusUrl, 6500).catch(() => null);
      if (relayReport?.status) publishDirectory(rows, relayReport.status);
    }
  }).catch(() => { directoryResult = -1; }).finally(() => { directoryRequest = null; });
}

function nextServerDirectoryRow() {
  if (directoryResult === 2 && directoryIndex < directoryRows.length) return directoryRows[directoryIndex++];
  const result = directoryResult;
  directoryRows = [];
  directoryResult = 0;
  return result;
}

async function fetchRelayTicket(query, signal, timeout) {
  const ticketUrl = new URL("/api/relay/ticket", backend);
  ticketUrl.search = query.toString();
  const request = new AbortController();
  const cancel = () => request.abort(signal.reason);
  const timer = setTimeout(() => request.abort(new DOMException("Relay request timed out", "TimeoutError")), timeout);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(ticketUrl, {
      cache: "no-store",
      signal: request.signal,
    });
    return { response, body: await response.json().catch(() => null) };
  } finally {
    signal.removeEventListener("abort", cancel);
    clearTimeout(timer);
  }
}

async function connectionConfig(server, signal) {
  const local = await getLocalRelay();
  signal.throwIfAborted();
  if (local?.available) return local;
  const query = new URLSearchParams({ address: server.address, port: String(server.port) });
  const started = Date.now();
  const deadline = started + relayStartupTimeout;
  const startupError = "The multiplayer relay didn’t come online. Try again shortly.";
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const timeout = Math.min(12_000, Math.max(1, deadline - Date.now()));
    const { response, body } = await fetchRelayTicket(query, signal, timeout).catch(error => {
      if (signal.aborted || (error.name !== "TimeoutError" && !(error instanceof TypeError))) throw error;
      return {};
    });
    signal.throwIfAborted();
    if (response?.ok && body) return body;
    if (response && !(response.status === 503 && body?.starting) && ![502, 504].includes(response.status)) {
      throw new Error(body?.error || "The multiplayer relay couldn’t be reached.");
    }
    const elapsed = Math.floor((Date.now() - started) / 1000);
    setGameStatus(elapsed ? `Starting multiplayer relay… ${elapsed}s` : "Starting multiplayer relay…");
    const wait = Math.min(relayRetryInterval, Math.max(0, deadline - Date.now()));
    await new Promise(resolve => setTimeout(resolve, wait));
  }
  throw new Error(startupError);
}

function openTransport(server, config) {
  const url = new URL(config.url);
  url.searchParams.set("address", server.address);
  url.searchParams.set("port", String(server.port));
  url.searchParams.set("fast", "1");
  const credential = config.ticket ? `ticket.${config.ticket}` : `key.${config.key}`;
  const socket = new WebSocket(url, ["srb2-netplay-v1", credential]);
  socket.binaryType = "arraybuffer";
  const state = {
    socket, server, attached: false, cachedAddons: new Set(),
    packets: new Array(packetQueueSize), nextPacket: 0, lastPacket: 0,
  };
  function enqueue(bytes) {
    if (state.lastPacket - state.nextPacket < packetQueueSize) {
      state.packets[state.lastPacket++ % packetQueueSize] = bytes;
    }
  }
  function receive(frame) {
    if (frame.byteLength <= packetLimit) {
      if (frame.byteLength >= 8) enqueue(new Uint8Array(frame));
      return;
    }
    if (frame.byteLength > 26 * 1024) return;
    const header = new DataView(frame);
    for (let offset = 0; offset + 2 <= frame.byteLength;) {
      const length = header.getUint16(offset, true);
      offset += 2;
      if (length < 8 || length > packetLimit || offset + length > frame.byteLength) break;
      enqueue(new Uint8Array(frame, offset, length));
      offset += length;
    }
  }
  state.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("The relay did not respond."));
      socket.close();
    }, 9000);
    socket.addEventListener("message", event => {
      if (event.data === "ready") {
        clearTimeout(timer);
        resolve();
      } else if (event.data instanceof ArrayBuffer) {
        receive(event.data);
      } else if (typeof event.data === "string" && event.data.startsWith("{")) {
        try {
          const hints = JSON.parse(event.data);
          if (/^[A-Za-z0-9_-]{32}$/.test(hints.addonKey) && Array.isArray(hints.cached)) {
            state.addonKey = hints.addonKey;
            state.mirror = hints.mirror === true;
            state.cachedAddons = new Set(hints.cached);
          }
        } catch { /* The ordinary game transport still works. */ }
      }
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      reject(new Error("Couldn’t connect through the relay. Try again or choose another server."));
      if (state === transport) {
        nextCommand = undefined;
        transport = undefined;
        if (joining && !state.attached) {
          finishRelayWait();
          joining = false;
          setGameStatus("The multiplayer relay disconnected before SRB2 could join.", true);
        } else if (state.attached && !joining) setGameStatus("Multiplayer relay disconnected.", true);
      }
    });
  });
  return state;
}

function finishRelayWait() {
  relayAttempt = undefined;
  cancelJoin.hidden = true;
}

function cancelRelayJoin() {
  if (!relayAttempt) return;
  relayAttempt.abort();
  finishRelayWait();
  joining = false;
  savegameRetryTarget = undefined;
  nextCommand = undefined;
  gameTransport.detach();
  setGameStatus("");
  canvas.focus({ preventScroll: true });
}

async function joinListedServer(target, retrying = false) {
  if (!running || joining) return;
  if (transport?.attached) {
    setGameStatus("End your current game from the SRB2 menu before joining another server.", true);
    return;
  }
  const match = /^(?:\[([\da-f:.]+)\]|([\d.]+))(?::(\d+))?$/i.exec(target.trim());
  const address = normalizeAddress(match?.[1] || match?.[2]);
  const port = Number(match?.[3] || 5029);
  if (!address || !Number.isInteger(port) || port < 1 || port > 65535) {
    setGameStatus("Enter a server’s IP address and UDP port, or choose it in the server browser.", true);
    return;
  }
  const name = serverNames.get(endpoint(address, port)) || endpoint(address, port);
  const server = { address, port, name };
  const attempt = new AbortController();
  relayAttempt = attempt;
  savegameRetryTarget = retrying ? undefined : target;
  joining = true;
  canvas.focus({ preventScroll: true });
  cancelJoin.hidden = false;
  setGameStatus(retrying
    ? `Game state download stalled. Rejoining ${server.name}…`
    : `Opening relay for ${server.name}…`);
  try {
    const config = await connectionConfig(server, attempt.signal);
    if (relayAttempt !== attempt) return;
    const state = openTransport(server, config);
    transport = state;
    await state.ready;
    if (relayAttempt !== attempt) return;
    if (transport !== state || state.socket.readyState !== WebSocket.OPEN) {
      throw new Error("The multiplayer relay closed before SRB2 could connect.");
    }
    nextCommand = `connect ${server.address} ${server.port}\n`;
    setGameStatus(`Contacting ${server.name} in SRB2…`);
    canvas.focus({ preventScroll: true });
  } catch (error) {
    if (relayAttempt !== attempt) return;
    finishRelayWait();
    joining = false;
    savegameRetryTarget = undefined;
    nextCommand = undefined;
    gameTransport.detach();
    setGameStatus(error.message, true);
  }
}

const gameTransport = {
  isOpen() {
    return transport?.socket.readyState === WebSocket.OPEN;
  },
  attach(address, port) {
    if (transport?.socket.readyState !== WebSocket.OPEN ||
        transport.server.address !== address || transport.server.port !== port) return false;
    transport.attached = true;
    finishRelayWait();
    gameNotice.hidden = true;
    return true;
  },
  detach() {
    const state = transport;
    transport = undefined;
    state?.socket.close();
    if (!joining && state?.attached) setGameStatus("Ready. Choose a server or play locally.");
  },
  receive() {
    const state = transport;
    if (!state || state.nextPacket === state.lastPacket) return;
    const index = state.nextPacket++ % packetQueueSize;
    const packet = state.packets[index];
    state.packets[index] = undefined;
    return packet;
  },
  send(packet) {
    const socket = transport?.socket;
    if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 128 * 1024) socket.send(packet);
  },
};

async function loadPacks() {
  const names = Object.keys(gameData);
  downloadProgress.max = names.reduce((total, name) => total + gameData[name].size, 0);
  downloadProgress.value = 0;
  downloadProgress.hidden = false;
  const packs = new Map();
  let completed = 0;
  for (const name of names) {
    setGameStatus(name === modelArchive ? "Loading 3D models…" : `Loading ${name}…`);
    const bytes = await loadGameData(name, size => { downloadProgress.value = completed + size; });
    if (name === modelArchive) {
      for await (const [path, model] of unpackModels(bytes)) packs.set(path, model);
    } else {
      packs.set(name, bytes);
    }
    completed += bytes.byteLength;
    downloadProgress.value = completed;
  }
  return packs;
}

function syncSaves(populate) {
  return new Promise((resolve, reject) => runtime.FS.syncfs(populate, error =>
    error ? reject(error) : resolve()
  ));
}

function saveProgress() {
  if (!running || syncing) return;
  syncing = syncSaves(false).catch(() => {}).finally(() => { syncing = null; });
}

function launchFailed(message) {
  relayAttempt?.abort();
  finishRelayWait();
  nextCommand = undefined;
  savegameRetryTarget = undefined;
  running = loading = joining = false;
  resumeGameAudio = undefined;
  restartRequired = true;
  document.title = siteTitle;
  touch.setActive(false);
  clearInterval(syncTimer);
  gameTransport.detach();
  stretch.hidden = true;
  canvas.hidden = true;
  screen.classList.remove("running");
  loader.hidden = false;
  loader.querySelector("h2").textContent = "Game stopped";
  retry.textContent = "Reload game";
  retry.hidden = false;
  setGameStatus(message, true);
}

async function startGame() {
  if (loading || running) return;
  loading = true;
  retry.hidden = true;
  loader.querySelector("h2").textContent = "Loading SRB2";
  let packs;
  try {
    packs = await loadPacks();
  } catch (error) {
    loading = false;
    loader.querySelector("h2").textContent = "Download interrupted";
    retry.hidden = false;
    setGameStatus(error.message || "The game download failed. Try again.", true);
    return;
  } finally {
    downloadProgress.hidden = true;
  }
  setGameStatus("Starting SRB2…");
  try {
    const buildQuery = new URL(import.meta.url).search;
    const { default: createGame } = await import(`./srb2.mjs${buildQuery}`);
    runtime = await createGame({
      canvas,
      locateFile: filename => new URL(filename + buildQuery, import.meta.url).href,
      srb2Transport: gameTransport,
      addonDownload,
      nextTouchButton: touch.nextButton,
      print(message) {
        lastLog = message;
        console.info(message);
      },
      printErr(message) {
        lastLog = message;
        console.warn(message);
      },
      onAbort(message) {
        launchFailed(`SRB2 stopped. ${message || lastLog}`);
      },
      onGameError(message) {
        launchFailed(`SRB2 stopped. ${message}`);
      },
      onExit(code) {
        if (!loading && !running) return;
        if (code) launchFailed(`SRB2 stopped. ${lastLog || `Exit code ${code}`}`);
        else {
          saveProgress();
          launchFailed("SRB2 closed. Reload the game to start again.");
        }
      },
      onGameReady(resumeAudio) {
        loading = false;
        running = true;
        resumeGameAudio = resumeAudio;
        document.title = siteTitle;
        setGameStatus("Ready. Click the game to use the keyboard.");
        touch.setActive(true);
        fitGame();
        stretch.hidden = false;
        canvas.focus({ preventScroll: true });
      },
      requestServerDirectory,
      nextServerDirectoryRow,
      readServerStatus: target => serverDetails[target],
      serverRelayAvailable: () => relayReady,
      joinListedServer,
      nextGameCommand() {
        const command = nextCommand;
        nextCommand = undefined;
        return command;
      },
      onJoinFinished(joined, savegameStalled) {
        const server = transport?.server;
        const retryTarget = savegameRetryTarget;
        savegameRetryTarget = undefined;
        finishRelayWait();
        joining = false;
        if (joined && server) {
          saveProgress();
          setGameStatus(`Connected to ${server.name}.`);
        } else {
          gameTransport.detach();
          if (savegameStalled && retryTarget) {
            void joinListedServer(retryTarget, true);
          } else {
            setGameStatus(savegameStalled
              ? "The server stopped sending the game state. Try joining again."
              : "", savegameStalled);
          }
        }
      },
    });
    runtime.FS.mkdir("/game");
    runtime.FS.mkdir("/save");
    try {
      runtime.FS.mount(runtime.IDBFS, {}, "/save");
      await syncSaves(true);
      syncTimer = setInterval(saveProgress, 8000);
    } catch {
      console.warn("Browser storage is unavailable for SRB2 saves.");
    }
    runtime.FS.mkdirTree("/save/.srb2");
    for (const [name, bytes] of packs) {
      const path = `/game/${name}`;
      runtime.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
      runtime.FS.writeFile(path, bytes, { canOwn: true });
    }
    runtime.FS.chdir("/game");
    loader.hidden = true;
    canvas.hidden = false;
    screen.classList.add("running");
    // Keep SDL windowed so the canvas follows the page's layout.
    const result = runtime.callMain(["-home", "/save", "-win", "-nolog"]);
    if (result?.catch) result.catch(error => launchFailed(String(error)));
  } catch (error) {
    launchFailed(`SRB2 couldn’t start. ${lastLog || error.message}`);
  }
}

retry.addEventListener("click", () => {
  if (restartRequired) location.reload();
  else void startGame();
});
cancelJoin.addEventListener("click", cancelRelayJoin);
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !relayAttempt) return;
  event.preventDefault();
  event.stopPropagation();
  cancelRelayJoin();
}, { capture: true });
for (const type of ["pointerup", "keydown", "click"]) {
  document.addEventListener(type, () => resumeGameAudio?.(), { capture: true });
}
// SDL listens on the window. Let browser controls keep their keyboard behavior.
for (const type of ["keydown", "keypress"]) {
  document.addEventListener(type, event => {
    if (event.target !== canvas) event.stopPropagation();
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveProgress();
});
// Wake the on-demand relay once while the player's game files load.
void readJson(hostedOnPages ? "/healthz" : "/api/relay", 8000).catch(() => null);
void startGame();
