import { ConnectionStatus } from './ConnectionStatus'
import NotifBell from './NotifBell'

function goHome() {
  window.top.location.href = 'https://truescale-group.github.io/mixue-ice-sakon/'
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
        <button className="topbar-refresh-btn" onClick={() => window.location.reload()} title="รีเฟรช">
          🔄
        </button>
      </div>
    </div>
  )
}
