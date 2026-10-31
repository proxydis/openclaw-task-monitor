// Requis pour l'installation (PWA). Volontairement sans cache : le tableau de bord est un flux
// temps réel, une réponse périmée serait pire qu'une page qui ne charge pas.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
