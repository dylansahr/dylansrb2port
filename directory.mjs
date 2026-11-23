const master = "https://ds.ms.srb2.org/MS/0/";
export const engineVersion = "2.2.15";

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeAddress(value) {
  if (typeof value !== "string" || value.length > 45) return null;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const octets = value.split(".").map(Number);
    return octets.every(octet => octet <= 255) ? octets.join(".") : null;
  }
  if (!value.includes(":") || !/^[0-9a-f:.]+$/i.test(value)) return null;
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

export function endpoint(address, port) {
  return `${address.includes(":") ? `[${address}]` : address}:${port}`;
}

function parseRooms(text) {
  return text.replaceAll("\r", "").split(/\n\n+/).flatMap(group => {
    const [id, name] = group.split("\n");
    return /^\d+$/.test(id) && name ? [{ id: Number(id), name }] : [];
  });
}

export function parseServers(text) {
  let room = null;
  const servers = [];
  for (const line of text.replaceAll("\r", "").split("\n")) {
    if (/^\d+$/.test(line)) {
      room = Number(line);
      continue;
    }
    const match = /^(\S+) (\S+) (\S+) (\S+)$/.exec(line);
    if (!match || room === null) continue;
    const [, rawAddress, rawPort, rawName, rawVersion] = match;
    const address = normalizeAddress(decode(rawAddress));
    const port = Number(decode(rawPort));
    if (!address || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    servers.push({
      room, address, port,
      name: decode(rawName),
      version: decode(rawVersion).replace(/^v/i, ""),
    });
  }
  return servers;
}

async function readMaster(resource) {
  const response = await fetch(new URL(resource, master), {
    headers: { Accept: "text/plain" },
    redirect: "manual",
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`Master Server returned HTTP ${response.status}`);
  return response.text();
}

export async function fetchDirectory() {
  const [roomsText, serversText] = await Promise.all([
    readMaster("rooms"),
    readMaster("servers"),
  ]);
  const rooms = parseRooms(roomsText);
  if (!rooms.length) throw new Error("Master Server room list was unreadable");
  return { rooms, servers: parseServers(serversText), updatedAt: new Date().toISOString() };
}
