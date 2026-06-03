/* BizICE Inventory — Service Worker (L2 read-only PWA cache)
   ─────────────────────────────────────────────────────────────
   Strategy:
   • App shell (HTML, JS, CSS, images) → cache-first + network-revalidate
   • Firestore / Firebase / Google APIs → ผ่านตรงๆ (Firebase ใช้ IndexedDB ของตัวเองอยู่แล้ว)
   • อัปเดต SW เมื่อ deploy ใหม่ → bump CACHE_VERSION
*/

const CACHE_VERSION = 'bizice-inv-v2.0.36'
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-inventory.png',
]

self.addEventListener('install', (event) => {
  self.skipWaiting()   // อัปเดต SW ใหม่ทันที
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL).catch(() => null))
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)

  // 🔥 Firebase / Firestore / Google API → ผ่านตรง (Firebase จัดการ offline ของตัวเอง)
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebase.googleapis.com') ||
    url.hostname.includes('identitytoolkit') ||
    url.hostname.includes('securetoken')
  ) {
    return  // ไม่ intercept → ผ่าน network ตรงๆ
  }

  // 🌐 Google Fonts → cache-first (มี max-age ของตัวเองอยู่แล้ว)
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          const clone = res.clone()
          caches.open(CACHE_VERSION).then((c) => c.put(req, clone))
          return res
        }).catch(() => cached || new Response('', { status: 504 }))
      )
    )
    return
  }

  // 🏠 App shell (same-origin) → network-first → cache fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((res) => {
        // เก็บลงแคชเฉพาะ response ที่ใช้ได้
        if (res && res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone()
          caches.open(CACHE_VERSION).then((c) => c.put(req, clone))
        }
        return res
      }).catch(() =>
        caches.match(req).then((cached) =>
          cached || caches.match('./index.html')   // SPA fallback
        )
      )
    )
  }
})

// 🔄 รับคำสั่ง skip waiting จาก client (ถ้า user กดอัพเดท)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})
