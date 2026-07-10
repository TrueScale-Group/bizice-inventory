// useStockBalances — shared singleton subscription ของ stock_balances (keyed by scope)
//   เป้าหมาย: ลด Firestore read — เดิมแต่ละหน้า/ component เปิด onSnapshot(stock_balances) เอง (5 จุด)
//   ตอนนี้แชร์ listener ตาม "scope key":
//     • 'all'          → collection เต็ม (ทุกคลัง) — NotifBell / Dashboard / Settings / Warehouse(owner=all)
//     • <warehouseId>  → where warehouseId == id (กรองสาขาเดียว) — CutStock / Warehouse(staff)
//   consumer ที่ scope เดียวกันใช้ listener ตัวเดียวกัน · ref-count ปิดเมื่อไม่มีผู้ใช้ · cache ข้าม mount
//   pattern เดียวกับ useItems.js
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { collection, query, where, onSnapshot, getDocsFromCache } from 'firebase/firestore'
import { db } from '../firebase'
import { COL } from '../constants/collections'
import { registerPausable } from './_visibilityPause'

const EMPTY = []                       // อ้างอิงคงที่ (กัน useSyncExternalStore loop เมื่อไม่มี scope)
const _noopSub = () => () => {}

// stores: Map<scopeKey, { data, loaded, unsub, refs, subs:Set }>
const _stores = new Map()
let _paused = false                    // แท็บถูกซ่อนนานเกินกำหนด → พัก listener ทุก scope

function _store(key) {
  let s = _stores.get(key)
  if (!s) {
    s = { data: [], loaded: false, unsub: null, refs: 0, subs: new Set() }
    _stores.set(key, s)
  }
  return s
}

function _emit(s) { s.subs.forEach(fn => fn()) }

function _start(key) {
  const s = _store(key)
  if (s.unsub || _paused) return
  const ref = key === 'all'
    ? collection(db, COL.STOCK_BALANCES)
    : query(collection(db, COL.STOCK_BALANCES), where('warehouseId', '==', key))
  s.unsub = onSnapshot(ref, snap => {
    s.data = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    s.loaded = true
    _emit(s)
  }, err => { console.warn('[useStockBalances] snapshot error:', err?.message || err) })
}

function _makeSubscribe(key) {
  return (cb) => {
    const s = _store(key)
    s.subs.add(cb)
    s.refs++
    _start(key)
    return () => {
      s.subs.delete(cb)
      s.refs--
      if (s.refs <= 0 && s.unsub) { s.unsub(); s.unsub = null; s.refs = 0 }
      // เก็บ data / loaded ไว้เป็น cache (mount ใหม่เห็นข้อมูลทันที ไม่ flash ว่าง)
    }
  }
}

function _queryFor(key) {
  return key === 'all'
    ? collection(db, COL.STOCK_BALANCES)
    : query(collection(db, COL.STOCK_BALANCES), where('warehouseId', '==', key))
}

// passive subscribe — รับ update เมื่อ store เปลี่ยน แต่ "ไม่" เปิด listener เอง (ไม่ +ref, ไม่ _start)
//   ใช้กับ consumer ที่อยากเห็นข้อมูล cache + เกาะ listener ของคนอื่น (ถ้ามี) โดยไม่บังคับให้ listener เปิดค้าง
function _passiveSubscribe(key) {
  return (cb) => {
    const s = _store(key)
    s.subs.add(cb)
    return () => { s.subs.delete(cb) }
  }
}

// พัก/ต่อ listener ทุก scope ตามการมองเห็นของแท็บ — คง refs/subs ไว้ (กลับมาแล้ว sync เฉพาะ delta)
registerPausable({
  pause() {
    _paused = true
    _stores.forEach(s => { if (s.unsub) { s.unsub(); s.unsub = null } })
  },
  resume() {
    _paused = false
    _stores.forEach((s, key) => { if (s.refs > 0 && !s.unsub) _start(key) })
  },
})

/**
 * stock_balances ตาม scope — แชร์ subscription ต่อ scope key
 * @param {string} scopeKey  'all' = ทุกคลัง · <warehouseId> = สาขาเดียว · falsy = ไม่ subscribe (คืน [])
 */
export function useStockBalances(scopeKey) {
  const key = scopeKey || null
  const subscribe   = useMemo(() => key ? _makeSubscribe(key) : _noopSub, [key])
  const getSnapshot = useMemo(() => key ? () => _store(key).data : () => EMPTY, [key])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** true เมื่อโหลด balances ของ scope นั้นครั้งแรกเสร็จ (falsy scope = true) */
export function useStockBalancesLoaded(scopeKey) {
  const key = scopeKey || null
  const subscribe   = useMemo(() => key ? _makeSubscribe(key) : _noopSub, [key])
  const getSnapshot = useMemo(() => key ? () => _store(key).loaded : () => true, [key])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * passive — อ่าน balances จาก cache + เกาะ update ของ listener คนอื่น (ถ้ามี) โดย "ไม่เปิด listener เอง"
 *   เหมาะกับ badge ที่ไม่ต้อง live ตลอด (เช่น NotifBell): ถ้าหน้าอื่นเปิด scope นี้อยู่ → เห็นสด ฟรี ·
 *   ถ้าไม่มีใครเปิด → seed จาก local cache (getDocsFromCache, ไม่คิด read) แสดงค่าล่าสุดที่เคย sync
 */
export function useStockBalancesPassive(scopeKey) {
  const key = scopeKey || null
  // seed จาก local cache ครั้งเดียวถ้า store ยังว่างและไม่มี listener active (อ่าน cache = ไม่เสีย read)
  useEffect(() => {
    if (!key) return
    const s = _store(key)
    if (s.loaded || s.unsub) return
    getDocsFromCache(_queryFor(key))
      .then(snap => {
        if (s.unsub || s.loaded) return   // มีคนเปิด listener แซงไปแล้ว → ใช้ของนั้น
        s.data = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        s.loaded = true
        _emit(s)
      })
      .catch(() => {})
  }, [key])
  const subscribe   = useMemo(() => key ? _passiveSubscribe(key) : _noopSub, [key])
  const getSnapshot = useMemo(() => key ? () => _store(key).data : () => EMPTY, [key])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** balances เป็น map { docId: balance } — สำหรับ lookup ด้วย `${wh}_${itemId}` (เช่น Settings) */
export function useStockBalanceMap(scopeKey = 'all') {
  const arr = useStockBalances(scopeKey)
  return useMemo(() => {
    const m = {}
    for (const b of arr) m[b.id] = b
    return m
  }, [arr])
}
