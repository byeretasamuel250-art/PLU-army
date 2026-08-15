// This service worker does two different things for two different
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
const MEDIA_CACHE_NAME = 'plu-media-cache-v1';
const MEDIA_URL_MARKER = '/storage/v1/object/public/post-media/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if(!url.includes(MEDIA_URL_MARKER)) return; // not a media file — don't touch it

  event.respondWith(
    caches.open(MEDIA_CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if(cached) return cached;
      const response = await fetch(event.request);
      // Only cache a real, successful download — never cache an error
      // response, which would otherwise get stuck "downloaded" forever.
      if(response && response.ok){
        cache.put(event.request, response.clone());
      }
      return response;
    })
  );
});
