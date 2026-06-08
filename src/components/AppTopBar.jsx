import { ConnectionStatus } from './ConnectionStatus'
import NotifBell from './NotifBell'

function goHome() {
  window.top.location.href = 'https://truescale-group.github.io/mixue-ice-sakon/'
}

// Hard refresh — ล้าง Service Worker cache + unregister SW แล้ว reload (โหลดเวอร์ชันใหม่ล่าสุด)
async function hardRefresh() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
    }
  } catch (e) {
    console.warn('[hardRefresh]', e)
  } finally {
    // cache-bust query กัน browser ดึงจาก HTTP cache
    const url = new URL(window.location.href)
    url.searchParams.set('_r', Date.now().toString())
    window.location.replace(url.toString())
  }
}

const TAB_LABEL = {
  dashboard: 'แดชบอร์ด',
  warehouse: 'คลังสินค้า',
  cutstock:  'ตัดสต็อก',
  report:    'รายงาน',
  settings:  'ตั้งค่า',
}

export default function AppTopBar({ tab }) {
  return (
    <div className="app-topbar">
      {/* ปุ่ม Home */}
      <button className="app-back-btn" onClick={goHome}>
        🏠 Home
      </button>

      {/* Brand + ชื่อ page */}
      <div className="app-brand">
        <div className="app-brand-icon">
          <img src="./icon-inventory.png" alt="Inventory" />
        </div>
        <div className="app-brand-name">Mixue Inventory</div>
      </div>

      {/* Right — Online → Bell → Refresh (เหมือน Cost Manager) */}
      <div className="app-topbar-right">
        <ConnectionStatus />
        <NotifBell />
        <button className="topbar-refresh-btn" onClick={hardRefresh} title="รีเฟรช (ล้าง cache + โหลดใหม่)">
          🔄
        </button>
      </div>
    </div>
  )
}
