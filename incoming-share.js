/* Imported by sw.js. Shared bytes remain in the device's Cache Storage. */
const INCOMING_CACHE = "gdl-incoming-files-v1";
const INCOMING_PREFIX = "/__shared-inbox/";
async function receiveSharedFiles(request) {
  const saved = [];
  const cache = await caches.open(INCOMING_CACHE);
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter(value => value instanceof File);
    if (!files.length || files.length > 8) throw new Error("Choose one to eight audio or video files.");
    const existing = (await cache.keys()).filter(key => new URL(key.url).pathname.endsWith("/meta"));
    if (existing.length + files.length > 16) throw new Error("Open or dismiss the files already waiting in Generative Download first.");
    if (files.some(file => !file.size || file.size > 1_500_000_000 || !(file.type.startsWith("audio/") || file.type.startsWith("video/") || /\.(mp3|wav|wave|m4a|aac|flac|ogg|opus|webm|mp4|mov|m4v|mkv)$/i.test(file.name)))) throw new Error("Choose audio or video files smaller than 1.5 GB each.");
    for (const file of files) {
      const id = crypto.randomUUID(), url = new URL(INCOMING_PREFIX + id, self.location.origin).href;
      saved.push(url);
      await cache.put(url, new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream" } }));
      await cache.put(url + "/meta", new Response(JSON.stringify({ id, url, name: file.name, size: file.size, type: file.type, source: "web" }), { headers: { "Content-Type": "application/json" } }));
    }
    return Response.redirect(new URL("/mix?incoming=1", self.location.origin).href, 303);
  } catch (error) {
    for (const url of saved) { await cache.delete(url); await cache.delete(url + "/meta"); }
    // No server fallback: an unsuccessful share must never upload private media.
    return new Response("Could not open these files. " + (error instanceof Error ? error.message : "Storage may be full.") + " Return to Files and try again.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname === "/share-file" && event.request.method === "POST") event.respondWith(receiveSharedFiles(event.request));
});
