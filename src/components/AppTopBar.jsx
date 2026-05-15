import { ConnectionStatus } from './ConnectionStatus'

let _homeFirstPress = false
let _homeTimer = null
function goHome() {
  if (!_homeFirstPress) {
    _homeFirstPress = true
    // show toast
    const t = document.createElement('div')
    t.className = 'toast'
    t.textContent = 'กดอีกครั้งเพื่อกลับหน้าหลัก'
    t.style.cssText = 'background:#854D0E;color:#fff;'
    document.body.appendChild(t)
    setTimeout(() => { t.remove(); _homeFirstPress = false }, 2000)
    return
  }
  clearTimeout(_homeTimer)
  _homeFirstPress = false
  if (window.parent !== window) {
    window.parent.postMessage('closeApp', '*')
  } else {
    window.location.href = 'https://truescale-group.github.io/mixue-ice-sakon/'
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
        <div>
          <div className="app-brand-name">Mixue Inventory</div>
          {tab && (
            <div className="app-brand-sub">{TAB_LABEL[tab] || ''}</div>
          )}
        </div>
      </div>

      {/* Right */}
      <div className="app-topbar-right">
        <button className="topbar-refresh-btn hide-on-desktop" onClick={() => window.location.reload()} title="รีเฟรช">
          🔄
        </button>
        <ConnectionStatus />
      </div>
    </div>
  )
}
