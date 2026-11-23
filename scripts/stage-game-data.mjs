import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const [sitePath, manifestPath] = process.argv.slice(2);
if (!sitePath || !manifestPath) {
  throw new Error("Usage: node scripts/stage-game-data.mjs <site directory> <game data manifest>");
}
const { gameData, gameDataPath, modelArchive, releaseSize, releaseZip } =
  await import(pathToFileURL(resolve(manifestPath)));
const response = await fetch(releaseZip, { signal: AbortSignal.timeout(180_000) });
if (!response.ok) throw new Error(`Official SRB2 download returned HTTP ${response.status}.`);
const release = Buffer.from(await response.arrayBuffer());
if (release.length !== releaseSize) throw new Error("The official SRB2 archive changed size.");

const target = join(sitePath, gameDataPath);
await mkdir(target, { recursive: true });
for (const [name, entry] of Object.entries(gameData)) {
  const packed = release.subarray(entry.start, entry.end + 1);
  const bytes = name === modelArchive ? packed : inflateRawSync(packed, { maxOutputLength: entry.size });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== entry.size || sha256 !== entry.sha256) {
    throw new Error(`${name} did not match the official SRB2 release.`);
  }
  await writeFile(join(target, name), packed);
  console.log(`Verified and staged ${name}`);
}
