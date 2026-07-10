// กฎการเรียงคลัง (กลาง — ใช้ทุกหน้า):
//   สาขา (เก่าสุดก่อน = 509) → สาขาใหม่ที่เพิ่มจาก Hub (ต่อท้าย) → คลังกลาง (main) ท้ายสุด
// "ทุกร้าน" เป็น option UI แยก (แต่ละหน้าต่อท้ายเอง)
//
// หลักการ: เรียงตาม createdAt — 509/คลังกลางเดิมไม่มี createdAt (หรือเก่าสุด) → มาก่อน
//          สาขาใหม่จาก Hub มี createdAt → ต่อท้ายสาขาเดิม · main ถูกผลักท้ายเสมอ

const tsOf = (w) => {
  const c = w?.createdAt
  if (!c) return 0                                   // ไม่มี createdAt = ของเดิม → เก่าสุด
  if (typeof c.seconds === 'number') return c.seconds
  if (typeof c.toMillis === 'function') return c.toMillis() / 1000
  const n = new Date(c).getTime()
  return isNaN(n) ? 0 : n / 1000
}

export const isMainWarehouse = (w) => !!(w?.type === 'main' || w?.isMain)

export function sortWarehouses(list = []) {
  return [...list].sort((a, b) => {
    const am = isMainWarehouse(a) ? 1 : 0
    const bm = isMainWarehouse(b) ? 1 : 0
    if (am !== bm) return am - bm        // main → ท้ายสุด
    return tsOf(a) - tsOf(b)             // createdAt เก่าก่อน → 509 ก่อนสาขาใหม่
  })
}

// คลัง default = สาขาแรกตามกฎ (509) → fallback คลังแรก
// userBranchId: ถ้า staff มี branch_id → ใช้ตัวนั้นก่อน (ถ้ายังอยู่ใน list)
export function defaultWarehouseId(list = [], userBranchId = '') {
  if (userBranchId && list.find(w => w.id === userBranchId)) return userBranchId
  const sorted = sortWarehouses(list)
  const branch = sorted.find(w => !isMainWarehouse(w))
  return (branch || sorted[0])?.id || 'all'
}
