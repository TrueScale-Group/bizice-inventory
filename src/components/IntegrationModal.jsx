import { Modal } from './Modal'

const ROWS = [
  {
    icon: '🧮',
    name: 'Cost Manager',
    desc: 'ราคา/หน่วยวัตถุดิบ → คำนวณ Food Cost %',
    detail: 'Pull ผ่าน "Sync จาก Cost Manager" ที่หน้าตั้งค่า',
    status: 'ok',
  },
  {
    icon: '💵',
    name: 'Daily Income',
    desc: 'ยอดรายรับรายวัน → คำนวณ % ของเสีย / Gross Profit',
    detail: 'อ่านจาก income_records collection อัตโนมัติ',
    status: 'ok',
  },
  {
    icon: '🤖',
    name: 'น้องมี่ (LINE)',
    desc: 'แจ้งเตือน Stock ต่ำ / Food Cost spike ทาง LINE',
    detail: 'ส่งผ่าน push_queue → reporter mode',
    status: 'ok',
  },
]

export default function IntegrationModal({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="เชื่อมต่อระบบ">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 16px 16px' }}>
        {ROWS.map(r => (
          <div key={r.name} style={{
            display: 'flex', gap: 12, padding: 12, background: 'var(--bg)',
            borderRadius: 12, alignItems: 'flex-start',
          }}>
            <span style={{ fontSize: 28, lineHeight: 1 }}>{r.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <strong style={{ fontSize: 14, color: 'var(--txt)' }}>{r.name}</strong>
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                  background: '#F0FDF4', color: '#15803D', border: '1px solid #BBF7D0',
                }}>✓ เชื่อมต่อแล้ว</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 4 }}>{r.desc}</div>
              <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 4, fontStyle: 'italic' }}>{r.detail}</div>
            </div>
          </div>
        ))}
        <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE',
          borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#1D4ED8' }}>
          ℹ️ ทุกระบบใช้ Firestore project เดียวกัน (mixue-cost-manager) — sync แบบ real-time อัตโนมัติ
        </div>
      </div>
    </Modal>
  )
}
