/**
 * reconcileLotVsBalance — ตรวจว่า Σ LOT (ต่อคลัง,ต่อ item) == stock_balances.qty (V4 · P2)
 *
 * READ-ONLY เสมอ — แค่รายงาน drift ไม่แก้อะไร
 *   node scripts/reconcileLotVsBalance.mjs            → แสดง drift ทั้งหมด
 *   node scripts/reconcileLotVsBalance.mjs --all      → แสดงทุกคู่ (รวมที่ตรง)
 *   node scripts/reconcileLotVsBalance.mjs --tol 0.5  → ตั้ง threshold (default 0.01)
 */
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs } from 'firebase/firestore'

const app = initializeApp({
  apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain: 'mixue-cost-manager.firebaseapp.com',
  projectId: 'mixue-cost-manager',
  storageBucket: 'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId: '1:414432707376:web:1cf394f174257a86cdbef5',
})
const db = getFirestore(app)
const SHOW_ALL = process.argv.includes('--all')
const tolIdx = process.argv.indexOf('--tol')
const TOL = tolIdx >= 0 ? Number(process.argv[tolIdx + 1]) || 0.01 : 0.01

// ── โหลด master + warehouses (ชื่อ) ──
const [itemsSnap, whSnap, balSnap, lotSnap] = await Promise.all([
  getDocs(collection(db, 'Inv_items')),
  getDocs(collection(db, 'Inv_warehouses')),
  getDocs(collection(db, 'Inv_stock_balances')),
  getDocs(collection(db, 'Inv_lots')),
])
const itemName = {}; itemsSnap.docs.forEach(d => itemName[d.id] = d.data().displayName || d.data().name || d.id)
const whName = {}; whSnap.docs.forEach(d => whName[d.id] = d.data().name || d.id)
const unitOf = {}; itemsSnap.docs.forEach(d => unitOf[d.id] = d.data().unitUse || '')

// ── ยอดต่อ LOT แยกตามคลัง (รองรับ 2 schema) ──
function lotStockByWh(lot) {
  if (lot.status === 'split') return {}
  if (lot.locationQty && typeof lot.locationQty === 'object') {
    const o = {}
    for (const [wh, q] of Object.entries(lot.locationQty)) if ((Number(q) || 0) !== 0) o[wh] = Number(q) || 0
    return o
  }
  const o = {}
  if ((Number(lot.inWarehouse) || 0) !== 0) o[lot.warehouseId] = Number(lot.inWarehouse) || 0
  return o
}

// ── รวมยอด LOT ต่อ (wh_item) ──
const lotSum = {}
for (const d of lotSnap.docs) {
  const lot = d.data()
  const by = lotStockByWh(lot)
  for (const [wh, q] of Object.entries(by)) {
    const k = `${wh}_${lot.itemId}`
    lotSum[k] = (lotSum[k] || 0) + q
  }
}

// ── ยอด balance ต่อ (wh_item) ──
const balMap = {}
for (const d of balSnap.docs) {
  const b = d.data()
  if (!b.itemId || !b.warehouseId) continue
  balMap[`${b.warehouseId}_${b.itemId}`] = { qty: Number(b.qty) || 0, wh: b.warehouseId, itemId: b.itemId }
}

// ── เทียบ ──
const keys = new Set([...Object.keys(balMap), ...Object.keys(lotSum)])
const rows = []
for (const k of keys) {
  const bal = balMap[k]?.qty ?? 0
  const lot = lotSum[k] ?? 0
  const diff = Number((bal - lot).toFixed(3))
  const [wh, ...rest] = k.split('_'); const itemId = rest.join('_')
  rows.push({ wh, itemId, bal, lot, diff })
}
rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))

const drift = rows.filter(r => Math.abs(r.diff) > TOL)
console.log(`เทียบ ${rows.length} คู่ (คลัง×item) · tolerance ±${TOL}`)
console.log(`✅ ตรง: ${rows.length - drift.length} · ⚠️ DRIFT: ${drift.length}\n`)

const show = SHOW_ALL ? rows : drift
if (show.length === 0) { console.log('🎉 ไม่มี drift — LOT กับ balance ตรงกันทุกคู่'); process.exit(0) }

console.log(`${'คลัง'.padEnd(14)} ${'วัตถุดิบ'.padEnd(22)} ${'balance'.padStart(9)} ${'ΣLOT'.padStart(9)} ${'diff'.padStart(8)}`)
console.log('─'.repeat(70))
for (const r of show) {
  const flag = Math.abs(r.diff) > TOL ? '  ⚠️' : ''
  console.log(`${(whName[r.wh] || r.wh).slice(0, 13).padEnd(14)} ${(itemName[r.itemId] || r.itemId).slice(0, 21).padEnd(22)} ${String(r.bal).padStart(9)} ${String(r.lot).padStart(9)} ${String(r.diff).padStart(8)}${flag} ${unitOf[r.itemId] || ''}`)
}
console.log('\nหมายเหตุ: diff>0 = balance มากกว่า LOT (LOT ขาด/ยังไม่ track) · diff<0 = LOT มากกว่า balance')
process.exit(0)
