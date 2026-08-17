// This service worker does three different things for three different
// kinds of requests:
//
// 1. Uploaded photos and voice notes (from the "post-media" Supabase
//    Storage bucket) — cached permanently. Every upload gets a unique,
//    never-reused filename (timestamped), so the same URL always means
//    the exact same bytes forever. Once downloaded once, it's served
//    straight from this device from then on — no re-downloading it
//    again next time you log in.
//
// 2. Everything else — the app's HTML/JS, and all chat data itself
//    (messages, likes, who's online, etc.) — left completely untouched,
//    exactly as if this service worker didn't exist. That data changes
//    constantly and must always come fresh from the network; caching
//    it would risk showing stale or wrong messages.
//
// 3. Push notifications — a phone can receive one of these even while
//    the app itself is completely closed, which is the whole reason
//    this has to live in the service worker rather than in index.html.
const MEDIA_CACHE_NAME = 'plu-media-cache-v2';
const MEDIA_URL_MARKER = '/storage/v1/object/public/post-media/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Bumped v1 -> v2 alongside the download-verification fix below.
    // Without also clearing out the old cache, anyone who'd already hit
    // the truncated-download bug would keep being served that same bad,
    // permanently-silent-partway-through file forever — the fix only
    // stops it from happening to a NEW download, it can't retroactively
    // repair one that's already sitting in the old cache. Deleting any
    // cache under the old name forces exactly one fresh, now-verified
    // re-download of whatever they'd already cached, the next time they
    // play it.
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n.startsWith('plu-media-cache-') && n !== MEDIA_CACHE_NAME)
           .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if(!url.includes(MEDIA_URL_MARKER)) return; // not a media file — don't touch it

  event.respondWith(handleMediaRequest(event.request));
});

// iOS Safari's <audio>/<video> player fetches media using HTTP Range
// requests (it streams/seeks in byte chunks) and refuses to play a
// response that isn't a real 206 Partial Content reply to that request.
// Chrome on Android plays a full 200 response anyway, which is why voice
// notes worked on Android but silently failed on iPhone. This serves
// correctly-sliced 206 responses from the cached file so both platforms
// play it.
async function handleMediaRequest(request){
  const cache = await caches.open(MEDIA_CACHE_NAME);
  let cached = await cache.match(request);

  if(!cached){
    // Kick the full-file download+cache off in the background (deduped
    // via inFlightDownloads inside fetchAndCacheFullFile, so this is
    // still exactly one download no matter how many overlapping Range
    // requests iOS fires while starting playback) — but this first,
    // never-yet-cached play does NOT wait on it to finish. A long voice
    // note is precisely the case where waiting for the WHOLE file
    // before playing even a second of it meant the download simply
    // hadn't finished (and, on a bad connection, kept retrying) by the
    // time the player itself gave up and reported a load failure —
    // short clips "worked" only because their full download usually
    // finished quickly enough to beat that timeout. Passing this first
    // request straight through to the network instead — honoring
    // whatever byte range the player actually asked for, same as a
    // plain, un-cached audio URL would behave — lets it start playing
    // immediately regardless of the file's length. Once the background
    // download finishes, every request after this one hits the cache
    // and gets the fast, locally-sliced path below.
    fetchAndCacheFullFile(request, cache).catch(() => {});

    // This first play is what the person actually hears, so — same as
    // fetchAndCacheFullFile below — a response that comes back "ok" but
    // shorter than its own declared Content-Length (a mobile connection
    // dropping mid-stream without fetch() itself throwing) must NOT be
    // handed straight to the player: that's exactly what "plays, then
    // errors partway through" was. fetchDirectVerified retries a couple
    // of times first instead of trusting the first response blindly.
    const direct = await fetchDirectVerified(request);
    if(direct) return direct;

    // Every direct attempt was truncated or failed outright. See if the
    // background download above has managed to finish in the meantime
    // before giving up.
    cached = await cache.match(request);
    if(!cached){
      return new Response('Media unavailable — check your connection and try again.', { status: 503 });
    }
  }

  const rangeHeader = request.headers.get('range');
  let buffer;
  try{
    buffer = await cached.clone().arrayBuffer();
  }catch(e){
    // A corrupted or partially-written cache entry (rare — e.g. the app
    // was force-closed mid-write on a previous attempt). Drop it and try
    // once more from a clean network fetch instead of serving a broken
    // file forever from here on.
    await cache.delete(request);
    cached = await fetchAndCacheFullFile(request, cache);
    if(!cached) return new Response('Media unavailable — try again.', { status: 503 });
    try{ buffer = await cached.clone().arrayBuffer(); }
    catch(e2){ return new Response('Media unavailable — try again.', { status: 503 }); }
  }
  const totalLength = buffer.byteLength;

  if(!rangeHeader){
    // No specific range asked for — serve the whole file, but advertise
    // range support so the player knows it can seek next time.
    const headers = new Headers(cached.headers);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(totalLength));
    return new Response(buffer, { status: 200, statusText: 'OK', headers });
  }

  // Parse "bytes=START-END" and clamp to the file's real size. Either
  // side may be omitted ("bytes=500-" means "from 500 to the end"), and
  // a request can also come in "suffix" form — "bytes=-500" means "the
  // LAST 500 bytes", not "bytes 0 through 500" — which the previous
  // version of this parsing didn't distinguish, silently serving the
  // wrong slice (the file's start instead of its end) whenever a player
  // used that form.
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  let start, end;
  if(match && !match[1] && match[2]){
    const suffixLength = parseInt(match[2], 10);
    start = Math.max(0, totalLength - suffixLength);
    end = totalLength - 1;
  } else {
    start = match && match[1] ? parseInt(match[1], 10) : 0;
    end = match && match[2] ? parseInt(match[2], 10) : totalLength - 1;
  }
  if(isNaN(start) || start < 0) start = 0;
  if(isNaN(end) || end >= totalLength) end = totalLength - 1;
  if(start > end){ start = 0; end = totalLength - 1; }

  const slice = buffer.slice(start, end + 1);
  const headers = new Headers(cached.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${totalLength}`);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(slice.byteLength));

  return new Response(slice, { status: 206, statusText: 'Partial Content', headers });
}

// Used only for the very first, not-yet-cached play (see handleMediaRequest
// above). Fetches the request the player actually asked for (whichever byte
// range that is) and — same reasoning as fetchAndCacheFullFile below —
// checks the bytes that actually arrived against the response's own
// declared Content-Length before trusting it. A dropped mobile connection
// can end a response early without fetch() itself throwing, so without this
// check a truncated stream would get handed straight to the player, which
// is what "plays, then errors partway through" actually was. Retries a
// couple of times with a short pause; returns null if every attempt is
// truncated or fails outright, so the caller can fall back to whatever the
// background full-file download has managed to produce in the meantime.
async function fetchDirectVerified(request){
  const maxAttempts = 3;
  for(let attempt = 0; attempt < maxAttempts; attempt++){
    try{
      const response = await fetch(request);
      if(!(response.ok || response.status === 206)){
        // A real HTTP error (404, 410, etc.) — retrying won't change it.
        return response;
      }
      const declaredLength = response.headers.get('content-length');
      const buffer = await response.clone().arrayBuffer();
      if(declaredLength && buffer.byteLength !== parseInt(declaredLength, 10)){
        // Truncated mid-stream — try again rather than handing this to
        // the player.
        if(attempt < maxAttempts - 1){
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        return null;
      }
      return response;
    }catch(e){
      // A genuine network-level failure — worth a retry too.
      if(attempt < maxAttempts - 1){
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  return null;
}

// Downloads the complete file and stores it in the cache, retrying a
// couple of times first with a short, increasing pause between attempts.
// Mobile-data connections dropping mid-download are routine on the kind
// of networks this app runs on — without any retry here, that one bad
// moment permanently "broke" that message's playback until the page was
// reloaded, which is what plays-then-fails actually was. Returns the
// cached Response on success, or null if every attempt genuinely failed.
//
// Concurrent requests for the SAME file (iOS Safari's <audio> element
// routinely fires off several overlapping Range requests for one voice
// note right as playback starts) are collapsed into one shared download
// instead of each kicking off its own — both to avoid hammering the
// network three times over for one tap of Play, and because two
// simultaneous downloads finishing at different times and both calling
// cache.put() for the same key is exactly the kind of race that could
// leave whichever one lands last (good or bad) as the final cached copy.
const inFlightDownloads = new Map(); // request URL -> shared in-progress download promise
async function fetchAndCacheFullFile(request, cache){
  const key = request.url;
  if(inFlightDownloads.has(key)) return inFlightDownloads.get(key);

  const promise = (async () => {
    const networkHeaders = new Headers(request.headers);
    networkHeaders.delete('range');
    const maxAttempts = 3;
    for(let attempt = 0; attempt < maxAttempts; attempt++){
      try{
        const response = await fetch(new Request(request.url, { headers: networkHeaders }));
        if(response && response.ok){
          // A dropped mobile-data connection mid-download can end the
          // response stream early WITHOUT fetch() itself throwing — it
          // still comes back "ok", just shorter than it should be.
          // Caching that truncated file as if it were the complete
          // voice note is exactly what caused playback to keep visibly
          // running (the player's own clock, based on the container's
          // declared duration) while going silent partway through: it
          // hit the missing tail of the file with nothing real left to
          // decode. Comparing the actual downloaded size against the
          // server's own declared Content-Length (Supabase Storage
          // always sends one for a complete object) catches that before
          // it's ever cached, and retries instead.
          const declaredLength = response.headers.get('content-length');
          const bodyBuffer = await response.clone().arrayBuffer();
          if(declaredLength && bodyBuffer.byteLength !== parseInt(declaredLength, 10)){
            if(attempt < maxAttempts - 1){
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
              continue;
            }
            return null;
          }
          // Only cache a real, complete, successful download — never
          // cache an error response or a truncated one, either of which
          // would otherwise get stuck "downloaded" forever.
          await cache.put(request, response.clone());
          return response;
        }
        // A real HTTP error (404, 410, etc.), not a network drop — retrying
        // the exact same request won't produce a different file, so stop
        // here instead of hammering the server three times for nothing.
        return null;
      }catch(e){
        // A genuine network-level failure (connection dropped mid-transfer,
        // request timed out) — exactly the transient case worth a retry.
        if(attempt < maxAttempts - 1){
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    return null;
  })();

  inFlightDownloads.set(key, promise);
  try{
    return await promise;
  } finally {
    inFlightDownloads.delete(key);
  }
}

// ====== PUSH NOTIFICATIONS ======
// Fires when a notification arrives from the server, even if the app
// isn't open in any tab right now — that's the entire point of a push
// notification. The payload is whatever JSON the sending side (the
// Edge Function, added in a later step) puts in it; title/body/url
// fall back to something sensible if any of them are missing.
self.addEventListener('push', (event) => {
  let data = {};
  try{ data = event.data ? event.data.json() : {}; }catch(e){ /* fall back to defaults below */ }

  const title = data.title || 'PLU ARMY';
  const options = {
    body: data.body || 'You have a new notification.',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: data.url || './' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification itself (not the app icon) — brings an
// already-open tab to the front if there is one, rather than always
// opening a fresh tab on top of it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for(const client of clientList){
        if('focus' in client) return client.focus();
      }
      if(clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
