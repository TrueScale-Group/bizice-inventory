// fixCancelSwap.mjs — แก้เคส "ยกเลิกผิดตัว" จากบั๊ก index (v2.11.19)
//   log itXeLd (16 มิ.ย. · ปิ่นโต): กรวยกระดาษ ถูกยกเลิกผิด · สติ๊กเกอร์ ที่ตั้งใจยกเลิกยังอยู่
//   → สลับให้ถูก: un-cancel กรวยกระดาษ (balance −1) · cancel สติ๊กเกอร์ (balance +1)
//
//   DEFAULT = DRY-RUN (อ่านอย่างเดียว ไม่เขียน)   ·   ใส่ --commit เพื่อลงจริง
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs, doc, getDoc, writeBatch, increment, serverTimestamp } from 'firebase/firestore'

const COMMIT = process.argv.includes('--commit')
const db = getFirestore(initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', projectId:'mixue-cost-manager' }))

const logs = (await getDocs(collection(db, 'Inv_cut_logs'))).docs.map(d => ({ id: d.id, ...d.data() }))
const log = logs.find(l =>
  (l.items || []).some(it => (it.itemName || '').includes('กรวยกระดาษ') && it.cancelled) &&
  (l.items || []).some(it => (it.itemName || '').includes('สติ')))

if (!log) { console.log('❌ ไม่เจอ log ที่เข้าเงื่อนไข'); process.exit(0) }

const items = log.items || []
const coneIdx    = items.findIndex(it => (it.itemName || '').includes('กรวยกระดาษ') && it.cancelled)
const stickerIdx = items.findIndex(it => (it.itemName || '').includes('สติ'))
const cone = items[coneIdx], sticker = items[stickerIdx]
const wh = log.warehouseId

console.log(`\n══ log ${log.id} (${log.date} · ${log.staffName} · wh=${wh}) ══`)
console.log(`  [${coneIdx}] กรวยกระดาษ : cancelled=${!!cone.cancelled} (เหตุผล: ${cone.cancelReason || '-'})`)
console.log(`  [${stickerIdx}] สติ๊กเกอร์ : cancelled=${!!sticker.cancelled}`)

// guard
if (!cone.cancelled || sticker.cancelled) {
  console.log('\n⚠️ สถานะไม่ตรงเงื่อนไข (กรวยต้อง cancelled / สติ๊กเกอร์ต้องยังไม่ cancelled) — หยุด')
  process.exit(0)
}

const coneQty    = Number(cone.qtyUse)    || Number(cone.qty)    || 0
const stickerQty = Number(sticker.qtyUse) || Number(sticker.qty) || 0
const coneBalId    = `${wh}_${cone.itemId}`
const stickerBalId = `${wh}_${sticker.itemId}`
const coneBal    = (await getDoc(doc(db, 'Inv_stock_balances', coneBalId))).data()    || {}
const stickerBal = (await getDoc(doc(db, 'Inv_stock_balances', stickerBalId))).data() || {}

console.log('\n── แผนการแก้ ──')
console.log(`  กรวยกระดาษ: un-cancel · balance ${coneBal.qty ?? '?'} → ${(coneBal.qty ?? 0) - coneQty}  (−${coneQty} ${cone.unitUse || cone.unit})`)
console.log(`  สติ๊กเกอร์ : cancel    · balance ${stickerBal.qty ?? '?'} → ${(stickerBal.qty ?? 0) + stickerQty}  (+${stickerQty} ${sticker.unitUse || sticker.unit})`)

if (!COMMIT) {
  console.log('\n🔵 DRY-RUN — ยังไม่เขียนอะไร · ใส่ --commit เพื่อลงจริง\n')
  process.exit(0)
}

// ── COMMIT ──
const now = serverTimestamp()
const newItems = items.map((it, i) => {
  if (i === coneIdx) { const { cancelled, cancelReason, cancelledAt, cancelledBy, ...rest } = it; return rest }
  if (i === stickerIdx) return { ...it, cancelled: true, cancelReason: cone.cancelReason || 'ตัดซ้ำกัน',
    cancelledAt: new Date().toISOString(), cancelledBy: 'แก้ไขระบบ (สลับยกเลิกผิดตัว)' }
  return it
})
const newTotalCost = newItems.filter(it => !it.cancelled).reduce((s, it) => s + (Number(it.costTotal) || 0), 0)

const batch = writeBatch(db)
batch.update(doc(db, 'Inv_cut_logs', log.id), { items: newItems, totalCost: newTotalCost, lastEditedAt: now, lastEditedBy: 'fix-script' })
batch.set(doc(db, 'Inv_stock_balances', coneBalId),    { warehouseId: wh, itemId: cone.itemId,    qty: increment(-coneQty),   unit: cone.unitUse || cone.unit || '',       lastUpdated: now }, { merge: true })
batch.set(doc(db, 'Inv_stock_balances', stickerBalId), { warehouseId: wh, itemId: sticker.itemId, qty: increment(stickerQty), unit: sticker.unitUse || sticker.unit || '', lastUpdated: now }, { merge: true })
batch.set(doc(collection(db, 'Inv_stock_movements')), { type: 'fix_cancel_swap', itemId: cone.itemId,    itemName: cone.itemName,    warehouseId: wh, qty: -coneQty,   qtyUse: -coneQty,   unit: cone.unitUse || cone.unit || '',       unitUse: cone.unitUse || cone.unit || '',       adjustReason: 'แก้บั๊กยกเลิกผิดตัว: un-cancel กรวยกระดาษ', note: `log ${log.id.slice(-6)}`, timestamp: now })
batch.set(doc(collection(db, 'Inv_stock_movements')), { type: 'fix_cancel_swap', itemId: sticker.itemId, itemName: sticker.itemName, warehouseId: wh, qty: stickerQty, qtyUse: stickerQty, unit: sticker.unitUse || sticker.unit || '', unitUse: sticker.unitUse || sticker.unit || '', adjustReason: 'แก้บั๊กยกเลิกผิดตัว: cancel สติ๊กเกอร์',    note: `log ${log.id.slice(-6)}`, timestamp: now })
batch.set(doc(collection(db, 'Inv_audit_logs')), { action: 'fix_cut_cancel_swap', warehouseId: wh, staffName: 'fix-script',
  detail: `แก้ยกเลิกผิดตัว log ${log.id.slice(-6)}: คืน กรวยกระดาษ (−${coneQty}) · ยกเลิก สติ๊กเกอร์ (+${stickerQty})`, timestamp: now })
await batch.commit()
console.log('\n✅ COMMIT สำเร็จ — สลับเรียบร้อย\n')
process.exit(0)
