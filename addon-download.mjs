export function createAddonDownload(getTransport, getFileSystem) {
  let current;

  async function download(transfer, transport, digest, size, path) {
    const url = new URL(transport.socket.url);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/addons/" + digest;
    url.search = "";
    const signal = AbortSignal.any([transfer.controller.signal, AbortSignal.timeout(120_000)]);
    let file;
    let reader;
    try {
      const response = await fetch(url, {
        headers: { Authorization: "Bearer " + transport.addonKey },
        credentials: "omit", cache: "no-store", redirect: "error", signal,
      });
      const length = response.headers.get("Content-Length");
      if (!response.ok || !response.body || (length !== null && Number(length) !== size)) {
        await response.body?.cancel();
        throw new Error("The relay could not serve this add-on");
      }
      signal.throwIfAborted();
      const fs = getFileSystem();
      reader = response.body.getReader();
      file = fs.open(path, "w");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        if (transfer.bytes + value.byteLength > size) throw new Error("Incorrect add-on size");
        fs.write(file, value, 0, value.byteLength);
        transfer.bytes += value.byteLength;
      }
      fs.close(file);
      file = null;
      transfer.result = transfer.bytes === size ? 1 : -1;
    } catch {
      transfer.result = -1;
    } finally {
      if (file) {
        try { getFileSystem().close(file); } catch { /* The engine will discard the partial file. */ }
      }
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  return {
    available() {
      const transport = getTransport();
      return Boolean(transport?.addonKey && (transport.mirror || transport.cachedAddons.size));
    },
    start(digest, size, path) {
      const transport = getTransport();
      if (!transport?.addonKey || (!transport.mirror && !transport.cachedAddons.has(digest))) return false;
      current = { controller: new AbortController(), bytes: 0, result: 0 };
      void download(current, transport, digest, size, path);
      return true;
    },
    poll() {
      return current || { result: -1, bytes: 0 };
    },
    abort() {
      current?.controller.abort();
      current = null;
    },
  };
}
