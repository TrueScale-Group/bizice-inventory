import { ConnectionStatus } from './ConnectionStatus'

const TAB_LABEL = {
  dashboard: 'แดชบอร์ด',
  warehouse: 'คลังสินค้า',
  cutstock:  'ตัดสต็อก',
  report:    'รายงาน',
  settings:  'ตั้งค่า',
}

export default function DesktopContentBar({ tab }) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('th-TH', {
    weekday: 'long', day: 'numeric', month: 'long',
    year: 'numeric',
  })
  const timeStr = now.toLocaleTimeString('th-TH', {
    hour: '2-digit', minute: '2-digit',
  })

  return (
    <div className="desk-content-bar">
      {/* วันที่ + เวลา */}
      <div className="desk-content-bar-date">
        <span className="dcb-page">{TAB_LABEL[tab] || ''}</span>
        <span className="dcb-sep">·</span>
        <span className="dcb-date">{dateStr}</span>
        <span className="dcb-time">{timeStr} น.</span>
      </div>

      {/* Online status */}
      <div className="desk-content-bar-right">
        <ConnectionStatus />
      </div>
    </div>
  )
}
