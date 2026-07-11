function goHome() {
  window.top.location.href = '/'
}

// Hard refresh — ล้าง cache + unregister SW แล้วโหลดใหม่ (เหมือน Cost Manager)
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
  } catch (e) { console.warn('[hardRefresh]', e) }
  finally {
    const url = new URL(window.location.href)
    url.searchParams.set('_r', Date.now().toString())
    window.location.replace(url.toString())
  }
}

const NAV_ITEMS = [
  { key: 'dashboard', icon: '📊', label: 'แดชบอร์ด' },
  { key: 'warehouse', icon: '🏪', label: 'คลังสินค้า' },
  { key: 'cutstock',  icon: '✂️', label: 'ตัดสต็อก' },
  { key: 'report',    icon: '📋', label: 'รายงาน' },
  { key: 'settings',  icon: '⚙️', label: 'ตั้งค่า' },
]

export default function DesktopSidebar({ tab, onChange }) {
  const session = window._bizSession || {}
  const name    = session.name  || 'ผู้ใช้งาน'
  const role    = (session.role || 'viewer').toLowerCase()
  const initial = name.charAt(0).toUpperCase()
  // รูปโปรไฟล์จาก Hub: s.photo → bizice_avatar_<phone> (same-origin)
  const photo   = session.photo ||
    (session.phone ? (() => { try { return localStorage.getItem('bizice_avatar_' + session.phone) } catch { return null } })() : null) || null

  // role badge colour
  const roleColor = role === 'owner'  ? '#E31E24' :
                    role === 'admin'  ? '#7C3AED' :
                    role === 'editor' ? '#0284C7' : '#6B7280'
  // role + emoji: 👑 Owner · 🛡️ Admin · ✏️ Editor · 👁️ Viewer
  const roleLabel = role === 'owner'  ? '👑 Owner' :
                    role === 'admin'  ? '🛡️ Admin' :
                    role === 'editor' ? '✏️ Editor' : '👁️ Viewer'

  return (
    <aside className="desk-sidebar">
      {/* ─── Brand ─── */}
      <div className="dsb-brand">
        <div className="dsb-brand-icon">
          <img src="./icon-inventory.png" alt="Inventory" />
        </div>
        <div>
          <div className="dsb-brand-name">Mixue Inventory</div>
          <div className="dsb-brand-sub">BizICE · ระบบจัดการคลังสินค้า</div>
        </div>
      </div>

      {/* ─── Scroll body ─── */}
      <div className="dsb-scroll">

        {/* Home button */}
        <button className="dsb-home-btn" onClick={goHome}>
          🏠 กลับหน้าหลัก
        </button>

        {/* Nav items */}
        <div className="dsb-sec-lbl">เมนู</div>
        <nav className="dsb-nav">
          {NAV_ITEMS.map(n => (
            <button
              key={n.key}
              className={`dsb-nav-item${tab === n.key ? ' active' : ''}`}
              onClick={() => onChange(n.key)}
            >
              <span className="dsb-nav-ico">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>

      </div>

      {/* ─── User footer ─── */}
      <div className="dsb-footer">
        <div className="dsb-avatar" style={photo
          ? { backgroundImage: `url(${photo})`, backgroundSize: 'cover', backgroundPosition: 'center' }
          : { background: roleColor }}>
          {photo ? '' : initial}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="dsb-user-name">{name}</div>
          <div className="dsb-user-role">{roleLabel}</div>
        </div>
        <button className="dsb-refresh-btn" onClick={hardRefresh}
          title="Hard Refresh — ล้างแคชและโหลดใหม่">🔄</button>
      </div>
    </aside>
  )
}
