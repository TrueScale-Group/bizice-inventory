export function sortLotsFIFO(lots) {
  return [...lots].sort((a, b) => {
    const parse = (s) => {
      const [d, m, y] = s.split('/').map(Number)
      return new Date(2500 + y, m - 1, d)
    }
    return parse(a.receiveDate) - parse(b.receiveDate)
  })
}

export function getExpStatus(expDate) {
  const [d, m, y] = expDate.split('/').map(Number)
  const exp  = new Date(2500 + y, m - 1, d)
  const days = Math.round((exp - new Date()) / 86400000)
  if (days < 0)   return { status: 'expired', days, color: '#FF3B30', label: 'หมดอายุ' }
  if (days <= 30) return { status: 'warning', days, color: '#92600A', label: `เหลือ ${days} วัน` }
  return { status: 'ok', days, color: '#1A7F37', label: `เหลือ ${days} วัน` }
}
