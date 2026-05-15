export function toThaiDate(date = new Date()) {
  return date.toLocaleDateString('th-TH', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
}

export function toThaiShort(date = new Date()) {
  return date.toLocaleDateString('th-TH', {
    year: '2-digit', month: 'short', day: 'numeric',
  })
}

export function toDateKey(date = new Date()) {
  const y = date.getFullYear() + 543
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function toThaiTime(ts) {
  const d = ts?.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
}

export function lotDateStr(date = new Date()) {
  const d = String(date.getDate()).padStart(2, '0')
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const y = String(date.getFullYear() - 2500).padStart(2, '0')
  return `${d}/${m}/${y}`
}
