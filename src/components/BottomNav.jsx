const TABS = [
  { id: 'dashboard', icon: '📊', label: 'แดชบอร์ด' },
  { id: 'warehouse', icon: '📦', label: 'คลัง' },
  { id: 'cutstock',  icon: '✂️', label: 'ตัดสต็อก' },
  { id: 'report',    icon: '📋', label: 'รายงาน' },
  { id: 'settings',  icon: '⚙️', label: 'ตั้งค่า' },
]

export function BottomNav({ active, onChange }) {
  return (
    <nav className="bottom-nav">
      {TABS.map(t => (
        <button
          key={t.id}
          className={`nav-item${active === t.id ? ' active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          <span className="nav-pill">
            <span className="nav-icon">{t.icon}</span>
          </span>
          <span className="nav-label">{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
