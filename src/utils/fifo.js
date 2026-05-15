/** Parse a date string — รองรับทั้ง ISO (YYYY-MM-DD) และ legacy (DD/MM/YY Buddhist) */
function parseDate(s) {
  if (!s) return null
  if (s.includes('-')) {
    // ISO format: YYYY-MM-DD (ค.ศ.)
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  // Legacy: DD/MM/YY (พ.ศ.) → แปลงเป็น ค.ศ.
  const [d, m, y] = s.split('/').map(Number)
  return new Date(2000 + y, m - 1, d)
}

/** แปลงวันที่เป็น DD-MM-YY */
export function formatDateDDMMYY(s) {
  if (!s) return '-'
  if (s.includes('-')) {
    const [y, m, d] = s.split('-')
    return `${d}-${m}-${String(y).slice(2)}`
  }
  // legacy DD/MM/YY → DD-MM-YY
  return s.replace(/\//g, '-')
}

export function sortLotsFIFO(lots) {
  return [...lots].sort((a, b) => {
    const da = parseDate(a.receiveDate)
    const db_ = parseDate(b.receiveDate)
    if (!da && !db_) return 0
    if (!da) return 1
    if (!db_) return -1
    return da - db_
  })
}

/**
 * คำนวณสถานะอายุ Lot
 * @param {string} expDate   - วันหมดอายุ (ISO YYYY-MM-DD หรือ DD/MM/YY พ.ศ.)
 * @param {object} thresholds - { yellow: number, red: number } — หน่วย: วัน
 *                              yellow = เริ่มเหลือน้อยกว่า (สีเหลือง)
 *                              red    = เริ่มเหลือน้อยกว่า (สีแดง, หรือ <= 0 = หมด)
 */
export function getExpStatus(expDate, thresholds = { yellow: 30, red: 7 }) {
  const exp = parseDate(expDate)
  if (!exp) return { status: 'ok', days: 999, color: '#1A7F37', label: 'ไม่ระบุ EXP' }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((exp - today) / 86400000)

  const redDays    = thresholds?.red    ?? 7
  const yellowDays = thresholds?.yellow ?? 30

  if (days < 0)          return { status: 'expired', days, color: '#FF3B30', label: 'หมดอายุแล้ว' }
  if (days <= redDays)   return { status: 'danger',  days, color: '#FF3B30', label: `เหลือ ${days} วัน` }
  if (days <= yellowDays)return { status: 'warning', days, color: '#D97706', label: `เหลือ ${days} วัน` }
  return                        { status: 'ok',      days, color: '#1A7F37', label: `เหลือ ${days} วัน` }
}
