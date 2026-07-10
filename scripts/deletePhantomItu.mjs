// deletePhantomItu.mjs — ลบ phantom income_records/2026-06-21_itu
// SAFETY: อ่านก่อน ตรวจว่าไม่มียอดขาย (morning/afternoon total) แล้วค่อยลบ
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc, deleteDoc } from 'firebase/firestore'

const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)

const TARGET = '2026-06-21_itu'
const ref = doc(db, 'income_records', TARGET)
const snap = await getDoc(ref)

if (!snap.exists()) {
  console.log(`✅ ไม่มี doc "${TARGET}" แล้ว (อาจถูกลบไปก่อนหน้า) — ไม่ต้องทำอะไร`)
  process.exit(0)
}

const d = snap.data()
const hasMorningTotal = d.morning?.total != null
const hasAfternoonTotal = d.afternoon?.total != null

console.log(`พบ doc "${TARGET}"`)
console.log(`  morning.total   : ${hasMorningTotal ? d.morning.total : '(ไม่มี)'}`)
console.log(`  afternoon.total : ${hasAfternoonTotal ? d.afternoon.total : '(ไม่มี)'}`)
console.log(`  fields          : ${Object.keys(d).join(', ')}`)

// SAFETY GUARD: ห้ามลบถ้ามียอดขาย
if (hasMorningTotal || hasAfternoonTotal) {
  console.log('\n⛔ ABORT: doc นี้มียอดขาย — ไม่ลบ (ต้องย้ายไป _509 ก่อน)')
  process.exit(1)
}

await deleteDoc(ref)
console.log(`\n🗑️ ลบ "${TARGET}" เรียบร้อย (ไม่มียอดขายติดอยู่ — เป็น handshake stub เท่านั้น)`)
process.exit(0)
