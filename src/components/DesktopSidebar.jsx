function goHome() {
  if (window.parent !== window) {
    window.parent.postMessage('closeApp', '*')
  } else {
    window.location.href = 'https://truescale-group.github.io/mixue-ice-sakon/'
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
  const role    = session.role  || 'viewer'
  const initial = name.charAt(0).toUpperCase()

  // role badge colour
  const roleColor = role === 'owner'  ? '#E31E24' :
                    role === 'editor' ? '#0284C7' : '#6B7280'
  const roleLabel = role === 'owner'  ? 'Owner' :
                    role === 'editor' ? 'Editor' : 'Viewer'

  // today Thai short date
  const today = new Date().toLocaleDateString('th-TH', {
    day: 'numeric', month: 'short',
  })

  return (
    <aside className="desk-sidebar">
      {/* ─── Brand ─── */}
      <div className="dsb-brand">
        <div className="dsb-brand-icon">
          <img src="./icon-inventory.png" alt="Inventory" />
        </div>
        <div>
          <div className="dsb-brand-name">Mixue Inventory</div>
          <div className="dsb-brand-sub">BizICE · Stock Manager</div>
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
        <div className="dsb-avatar" style={{ background: roleColor }}>
          {initial}
        </div>
        <div>
          <div className="dsb-user-name">{name}</div>
          <div className="dsb-user-role">{roleLabel}</div>
        </div>
        <div className="dsb-date">{today}</div>
      </div>
    </aside>
  )
}
