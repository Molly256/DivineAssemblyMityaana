self.addEventListener('install', (e) => {
  console.log('Service Worker installed');
  self.skipWaiting(); // activate immediately
});

self.addEventListener('activate', (e) => {
  console.log('Service Worker activated');
  e.waitUntil(self.clients.claim());
});

// Don't cache anything. Always go to network
self.addEventListener('fetch', (e) => {
  // just let the browser handle it
  return;
});