/* A service worker that caches nothing, on purpose.
 *
 * It exists for one reason: Android will not offer to install a web app to
 * the home screen unless a service worker with a fetch handler is
 * controlling the page. That is the whole job.
 *
 * Caching would be actively harmful here. RECON's update story is that the
 * shop PC is the master and everyone runs the version it is serving; a phone
 * holding last week's app code against this week's database is a bug nobody
 * would think to look for, and clearing it would mean talking somebody
 * through Safari's settings over the phone. The shop is on its own wifi and
 * the server is in the building, so there is nothing to gain either.
 *
 * If offline reading is ever wanted, it belongs behind a deliberate cache of
 * *data* with a visible "last updated" stamp -- not a silent cache of code.
 */

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    // Belt and braces: if an earlier version of this file ever did cache,
    // activating this one throws it all away rather than leaving it stranded.
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
