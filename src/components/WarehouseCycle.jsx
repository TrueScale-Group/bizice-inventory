import { sortWarehouses } from '../utils/warehouses'

/**
 * ปุ่มกดวนเลือกคลัง (cycle) — ใช้ร่วมทุกหน้า (แดชบอร์ด / คลัง / รายงาน)
 * ลำดับวนตามกฎกลาง: สาขา 509 → สาขาใหม่ → คลังกลาง → (ทุกร้าน) → วนกลับ
 *
 * props:
 *   warehouses  — array คลัง
 *   value       — id คลังที่เลือก (หรือ 'all')
 *   onChange    — fn(nextId)
 *   includeAll  — รวม "ทุกร้าน" ในวง (default true)
 *   style       — style เพิ่มเติม (เช่น flexShrink)
 */
export default function WarehouseCycle({ warehouses = [], value, onChange, includeAll = true, style, locked = false }) {
  if (!warehouses.length) return null
  const label = value === 'all' ? 'ทุกร้าน' : (warehouses.find(w => w.id === value)?.name || 'เลือกคลัง')
  const baseStyle = { flexShrink: 0, border: '1.5px solid var(--border2)', borderRadius: 20,
    padding: '6px 12px', fontSize: 12, fontWeight: 700, background: 'var(--surf)',
    color: 'var(--txt)', display: 'inline-flex', alignItems: 'center', gap: 6, ...style }

  if (locked) {
    return (
      <div title="สาขาของคุณ" style={baseStyle}>
        🏪 {label}
      </div>
    )
  }

  const opts = [...sortWarehouses(warehouses).map(w => w.id), ...(includeAll ? ['all'] : [])]
  return (
    <button onClick={() => { const i = opts.indexOf(value); onChange(opts[(i + 1) % opts.length]) }}
      title="กดเพื่อสลับคลัง"
      style={{ ...baseStyle, cursor: 'pointer' }}>
      🏪 {label}
      <span style={{ fontSize: 11.5, color: '#DC2626',
        fontFamily: "-apple-system, system-ui, 'Segoe UI Symbol', sans-serif" }}>⇄</span>
    </button>
  )
}
