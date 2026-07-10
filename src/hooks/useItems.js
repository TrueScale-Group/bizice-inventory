// useItems — shared singleton subscription ของ Inv_items (Master Data)
//   เป้าหมาย: ลด Firestore read — เดิมแต่ละหน้า/modal เปิด onSnapshot(Inv_items) เอง (8 จุด)
//   ตอนนี้มี listener "ตัวเดียว" ทั้งแอป · ref-count ปิดเมื่อไม่มีผู้ใช้ · ข้ามหน้าไม่ re-subscribe
import { useSyncExternalStore } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { COL } from '../constants/collections'
import { registerPausable } from './_visibilityPause'

let _items  = []          // cache ล่าสุด (อ้างอิงคงที่จนกว่า snapshot ใหม่จะมา)
let _loaded = false
let _unsub  = null
let _refs   = 0
let _paused = false       // แท็บถูกซ่อนนานเกินกำหนด → พัก listener (ดู _visibilityPause)
const _subs = new Set()

function _emit() { _subs.forEach(fn => fn()) }

function _start() {
  if (_unsub || _paused) return
  _unsub = onSnapshot(collection(db, COL.ITEMS), snap => {
    _items  = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    _loaded = true
    _emit()
  }, err => { console.warn('[useItems] snapshot error:', err?.message || err) })
}

// พัก/ต่อ listener ตามการมองเห็นของแท็บ — ยังคง refs/subs ไว้ (กลับมาแล้ว resume token sync เฉพาะ delta)
registerPausable({
  pause()  { _paused = true;  if (_unsub) { _unsub(); _unsub = null } },
  resume() { _paused = false; if (_refs > 0 && !_unsub) _start() },
})

function _subscribe(cb) {
  _subs.add(cb)
  _refs++
  _start()
  return () => {
    _subs.delete(cb)
    _refs--
    if (_refs <= 0 && _unsub) { _unsub(); _unsub = null; _refs = 0 }
    // เก็บ _items / _loaded ไว้เป็น cache (mount ใหม่เห็นข้อมูลทันที)
  }
}

/** รายการสินค้า (Master Data) — แชร์ subscription เดียวทั้งแอป */
export function useItems() {
  return useSyncExternalStore(_subscribe, () => _items)
}

/** true เมื่อโหลด Inv_items ครั้งแรกเสร็จแล้ว */
export function useItemsLoaded() {
  return useSyncExternalStore(_subscribe, () => _loaded)
}
