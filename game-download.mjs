import { gameData, gameDataPath, modelArchive } from "./game-data.mjs";
import { hostedOnPages } from "./backend.mjs";

const cacheName = "srb2-2.2.15-game-data";
const dataBase = hostedOnPages ? new URL(`.${gameDataPath}`, import.meta.url) : new URL(gameDataPath, location.origin);

function inflate() {
  try {
    return new DecompressionStream("deflate-raw");
  } catch {
    throw new Error("This browser can’t open game downloads. Try a newer browser.");
  }
}

async function verifiedBytes(stream, entry, progress) {
  const data = new Uint8Array(entry.size);
  const reader = stream.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > data.byteLength) throw new Error("Unexpected download size.");
      data.set(value, received);
      received += value.byteLength;
      progress(received);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (received !== data.byteLength) throw new Error("The download ended early.");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hex = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== entry.sha256) throw new Error("The file did not match the official SRB2 release.");
  return data;
}

export async function loadGameData(name, progress) {
  const entry = gameData[name];
  const path = new URL(name, dataBase).href;
  const cache = await globalThis.caches?.open(cacheName).catch(() => null);
  let cacheKey = path;
  let stored = await cache?.match(cacheKey).catch(() => null);
  if (!stored && cache && hostedOnPages) {
    // Keep downloads already cached by the Pages build before the hosting move.
    const keys = await cache.keys().catch(() => []);
    const previous = keys.find(key => new URL(key.url).pathname === gameDataPath + name);
    if (previous) {
      cacheKey = previous.url;
      stored = await cache.match(cacheKey).catch(() => null);
    }
  }
  if (stored?.body) {
    try {
      return await verifiedBytes(stored.body, entry, progress);
    } catch {
      await cache.delete(cacheKey).catch(() => {});
      progress(0);
    }
  }

  const response = await fetch(path, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Couldn’t download ${name}. Try again in a moment.`);
  const stream = name === modelArchive ? response.body : response.body.pipeThrough(inflate());
  const data = await verifiedBytes(stream, entry, progress);
  await cache?.put(path, new Response(data)).catch(() => {});
  return data;
}

export async function* unpackModels(archive) {
  // loadGameData verifies the entire range before we read its ZIP local headers.
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let offset = 0; offset < archive.byteLength;) {
    if (offset + 30 > archive.byteLength || view.getUint32(offset, true) !== 0x04034b50) {
      throw new Error("The 3D model archive has an invalid file header.");
    }
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const packedSize = view.getUint32(offset + 18, true);
    const fileSize = view.getUint32(offset + 22, true);
    const nameEnd = offset + 30 + view.getUint16(offset + 26, true);
    const dataStart = nameEnd + view.getUint16(offset + 28, true);
    const dataEnd = dataStart + packedSize;
    // Encrypted entries and data descriptors are outside this release format.
    if ((flags & 0x0009) || dataEnd > archive.byteLength || (method !== 0 && method !== 8)) {
      throw new Error("The 3D model archive has an unsupported entry.");
    }
    const name = decoder.decode(archive.subarray(offset + 30, nameEnd));
    if (!/^models\/(?:[\w.-]+\/)*(?:[\w.-]+)?$/.test(name) ||
        name.split("/").some(part => part === "." || part === "..")) {
      throw new Error("The 3D model archive has an invalid file name.");
    }
    const packed = archive.subarray(dataStart, dataEnd);
    offset = dataEnd;
    if (name.endsWith("/")) continue;

    const bytes = method === 0 ? packed : new Uint8Array(await new Response(
      new Blob([packed]).stream().pipeThrough(inflate())
    ).arrayBuffer());
    if (bytes.byteLength !== fileSize) throw new Error(`Couldn’t unpack ${name}.`);
    yield [name, bytes];
  }
}
