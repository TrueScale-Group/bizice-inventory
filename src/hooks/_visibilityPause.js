// _visibilityPause — พัก Firestore listener เมื่อแท็บถูกซ่อนนานเกินกำหนด
//   เป้าหมาย: เครื่องที่เปิดแอปค้าง (เช่น POS) แต่สลับไปแอป/แท็บอื่น → ไม่ต้องโดนชาร์จ read
//             ทุกครั้งที่สาขาไหนก็ตามแก้ข้อมูล · พอกลับมาโฟกัส resume token ดึงเฉพาะ delta (ถูก)
//   ปลอดภัย: ไม่มีข้อมูลหาย (กลับมาแล้ว sync ต่อ) · FCM push ยังทำงานแยกต่างหาก
//   หมายเหตุ: พักเฉพาะตอน "ซ่อน" จริง (document.hidden) — ถ้าเปิดค้าง foreground ทั้งวันจะไม่พัก (กัน false pause)
const _controllers = new Set()   // แต่ละตัว: { pause(), resume() }
let _wired = false
let _hideTimer = null

const PAUSE_DELAY_MS = 120000    // ซ่อนเกิน 2 นาที → พัก (กัน thrash ตอนสลับแท็บแว้บเดียว)

function _wire() {
  if (_wired || typeof document === 'undefined') return
  _wired = true
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (_hideTimer) clearTimeout(_hideTimer)
      _hideTimer = setTimeout(() => {
        _hideTimer = null
        _controllers.forEach(c => { try { c.pause() } catch {} })
      }, PAUSE_DELAY_MS)
    } else {
      if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null }   // ยังไม่ทันพัก → ยกเลิก
      _controllers.forEach(c => { try { c.resume() } catch {} })        // กลับมาโฟกัส → ต่อ listener
    }
  })
}

/** ลงทะเบียน singleton listener ให้พัก/ต่อ ตามการมองเห็นของแท็บ · คืน fn ถอนทะเบียน */
export function registerPausable(controller) {
  _wire()
  _controllers.add(controller)
  return () => _controllers.delete(controller)
}
