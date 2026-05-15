// dateKey format: YYYY-MM-DD (CE/AD) — ตรงกับ input[type=date]
export function toDateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// แสดงวันที่ภาษาไทย พ.ศ. จาก dateKey "2026-05-15"
export function toThaiDate(dateOrKey = new Date()) {
  const d = typeof dateOrKey === 'string' ? new Date(dateOrKey + 'T00:00:00') : dateOrKey
  return d.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function toThaiShort(dateOrKey = new Date()) {
  const d = typeof dateOrKey === 'string' ? new Date(dateOrKey + 'T00:00:00') : dateOrKey
  return d.toLocaleDateString('th-TH', { year: '2-digit', month: 'short', day: 'numeric' })
}

export function toThaiTime(ts) {
  const d = ts?.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
}

export function lotDateStr(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yy = String(date.getFullYear() + 543).slice(-2)
  return `${dd}/${mm}/${yy}`
}
