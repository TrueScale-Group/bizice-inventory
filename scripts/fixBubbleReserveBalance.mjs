// One-off fix: ไข่มุก (สำรอง) @ คลังกลาง — duplicate balance doc
//   keeper (whId_itemId) = ตั้งยอดจริง 3 ถุง · ลบ doc ผี (itemId_itemId, qty=10)
//   + บันทึก movement (adjust) + audit log เพื่อ traceability
// Usage: node scripts/fixBubbleReserveBalance.mjs            (dry-run, แสดงแผน)
//        node scripts/fixBubbleReserveBalance.mjs --commit   (เขียนจริง)

import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc, collection, addDoc, writeBatch, serverTimestamp } from 'firebase/firestore'

const app = initializeApp({
  apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain: 'mixue-cost-manager.firebaseapp.com',
  projectId: 'mixue-cost-manager',
  storageBucket: 'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId: '1:414432707376:web:1cf394f174257a86cdbef5',
})
const db = getFirestore(app)

const KEEPER_ID = 'N9DVUuD7HhgPJdQ38TNr_dKK6D3YbGOlDX6zJZjf1'   // whId_itemId (ถูกต้อง)
const GHOST_ID  = 'dKK6D3YbGOlDX6zJZjf1_dKK6D3YbGOlDX6zJZjf1'   // itemId_itemId (พิการ)
const WH_ID     = 'N9DVUuD7HhgPJdQ38TNr'
const ITEM_ID   = 'dKK6D3YbGOlDX6zJZjf1'
const ITEM_NAME = 'ไข่มุก (สำรอง)'
const REAL_QTY  = 3   // ของจริงที่นับได้ (ถุง)

const commit = process.argv.includes('--commit')

const keeperSnap = await getDoc(doc(db, 'Inv_stock_balances', KEEPER_ID))
const ghostSnap  = await getDoc(doc(db, 'Inv_stock_balances', GHOST_ID))
const keeperQty = keeperSnap.exists() ? (keeperSnap.data().qty || 0) : 0
const ghostQty  = ghostSnap.exists()  ? (ghostSnap.data().qty  || 0) : 0
const seenTotal = keeperQty + ghostQty
const delta = REAL_QTY - seenTotal

console.log('── แผนการแก้ ──')
console.log(`keeper (${KEEPER_ID}) qty: ${keeperQty} → ${REAL_QTY}`)
console.log(`ghost  (${GHOST_ID}) qty: ${ghostQty} → ลบทิ้ง`)
console.log(`ยอดที่ระบบเคยเห็น (รวม) = ${seenTotal} → ของจริง ${REAL_QTY}  (delta ${delta})`)

if (!commit) {
  console.log('\n(dry-run) ใส่ --commit เพื่อเขียนจริง')
  process.exit(0)
}

const batch = writeBatch(db)
batch.set(doc(db, 'Inv_stock_balances', KEEPER_ID), {
  warehouseId: WH_ID, itemId: ITEM_ID, qty: REAL_QTY,
  lastUpdated: serverTimestamp(), fixedDuplicate: true,
}, { merge: true })
batch.delete(doc(db, 'Inv_stock_balances', GHOST_ID))
await batch.commit()

await addDoc(collection(db, 'Inv_stock_movements'), {
  type: 'adjust', itemId: ITEM_ID, itemName: ITEM_NAME, warehouseId: WH_ID,
  qty: delta, qtyUse: delta, unit: 'ถุง', unitUse: 'ถุง',
  staffName: 'ระบบ (แก้ duplicate)', adjustReason: 'แก้ doc balance ซ้ำ — ตั้งยอดจริง',
  note: `ลบ doc ผี (qty=${ghostQty}) + ตั้งยอดจริง ${REAL_QTY} ถุง`,
  timestamp: serverTimestamp(),
})
await addDoc(collection(db, 'Inv_audit_logs'), {
  action: 'fix_duplicate_balance', staffName: 'ระบบ',
  detail: `${ITEM_NAME} @ คลังกลาง — ลบ doc ผี (qty=${ghostQty}) + ตั้งยอดจริง ${REAL_QTY} ถุง`,
  timestamp: serverTimestamp(),
})

console.log('\n✅ แก้เรียบร้อย — เหลือ balance doc เดียว = 3 ถุง')
process.exit(0)
