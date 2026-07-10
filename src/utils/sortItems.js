// ลำดับหมวดหมู่มาตรฐาน (canonical) — fallback เมื่อยังไม่ได้โหลด catOrder จาก Settings
export const CAT_ORDER = ['แยม','ผลไม้','ไซรัป','ท็อปปิ้ง','วัตถุดิบ','ขนม','บรรจุภัณฑ์','อื่นๆ','สูตรผสม']

// เรียงรายการตาม Master Data:
//   1) ตำแหน่งหมวดหมู่ตาม catOrder (ถ้ามี) → fallback CAT_ORDER
//   2) sortOrder ภายในหมวด (?? 999)
//   3) name localeCompare 'th' เป็นตัวตัดสินสุดท้าย
// คืนค่าเป็น array ใหม่เสมอ (ไม่ mutate ของเดิม)
export function sortByMaster(arr, { items, catOrder, getId } = {}) {
  const ORDER = (catOrder && catOrder.length) ? catOrder : CAT_ORDER
  // resolve master item สำหรับแต่ละ element
  const resolve = (el) => {
    if (items) {
      const id = getId ? getId(el) : (el.itemId ?? el.id)
      return items.find(m => m.id === id) || el
    }
    return el
  }
  return [...(arr || [])].sort((a, b) => {
    const ma = resolve(a), mb = resolve(b)
    const cia = ORDER.indexOf(ma?.category)
    const cib = ORDER.indexOf(mb?.category)
    const ca = cia < 0 ? 999 : cia
    const cb = cib < 0 ? 999 : cib
    if (ca !== cb) return ca - cb
    const sa = ma?.sortOrder ?? 999
    const sb = mb?.sortOrder ?? 999
    if (sa !== sb) return sa - sb
    return (ma?.name || '').localeCompare(mb?.name || '', 'th')
  })
}
