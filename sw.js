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
const MEDIA_CACHE_NAME = 'plu-media-cache-v1';
const MEDIA_URL_MARKER = '/storage/v1/object/public/post-media/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
    // Always fetch the COMPLETE file from the network (even if this
    // particular request came in with a Range header) so we cache one
    // full copy to slice from on every future request, including this one.
    const networkHeaders = new Headers(request.headers);
    networkHeaders.delete('range');
    const response = await fetch(new Request(request.url, { headers: networkHeaders }));
    // Only cache a real, successful download — never cache an error
    // response, which would otherwise get stuck "downloaded" forever.
    if(response && response.ok){
      await cache.put(request, response.clone());
      cached = response;
    } else {
      return response;
    }
  }

  const rangeHeader = request.headers.get('range');
  const buffer = await cached.clone().arrayBuffer();
  const totalLength = buffer.byteLength;

  if(!rangeHeader){
    // No specific range asked for — serve the whole file, but advertise
    // range support so the player knows it can seek next time.
    const headers = new Headers(cached.headers);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', String(totalLength));
    return new Response(buffer, { status: 200, statusText: 'OK', headers });
  }

  // Parse "bytes=START-END" (either side may be omitted) and clamp to
  // the file's real size.
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  let start = match && match[1] ? parseInt(match[1], 10) : 0;
  let end = match && match[2] ? parseInt(match[2], 10) : totalLength - 1;
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
