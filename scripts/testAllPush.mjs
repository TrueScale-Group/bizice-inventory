// testAllPush.mjs — ยิงทดสอบ push "ทุกชนิด" เข้าเครื่อง Owner (รันหลัง deploy V2)
//   6 ชนิดผ่าน Hub push (push_tokens → owner/admin) + 1 ชนิด Maintenance (Mtn_push_tokens)
//   เว้นช่วง 2.5 วิ/อัน → ปลดล็อกจอแล้วนับว่าเด้งครบไหม
//   ใช้: cd "01 - APP/03 - Inventory/scripts" && node testAllPush.mjs
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'

const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)
const functions = getFunctions(app, 'asia-southeast1')
const sendHubPush     = httpsCallable(functions, 'sendHubPush')
const notifyTaskDone  = httpsCallable(functions, 'notifyTaskDone')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const BRANCH_509 = 'OIFG4YmV1xs9RKLiIF22'   // Mixue - 509 (ใช้กับ Maintenance)

// ── 6 ชนิดที่ยิงผ่าน Hub push (sendHubPush) ──
const HUB = [
  { type:'shift_saved',    title:'💰 บันทึกยอด กะเช้า ☀️ · ทดสอบ',         body:'โดย ระบบทดสอบ' },
  { type:'shift_received', title:'🤝 รับกะ กะบ่าย 🌙 · ทดสอบ',             body:'รับโดย ระบบทดสอบ' },
  { type:'late-handover',  title:'⏰ กะเช้ายังไม่ส่งมอบ · ทดสอบ',          body:'เลย 17:00 แล้ว รีบส่งกะนะคะ 🙏' },
  { type:'late-handover',  title:'🔒 กะบ่ายยังไม่ปิดกะ · ทดสอบ',           body:'ปิดร้าน 20:30 แล้ว รีบส่งกะค่ะ 🌙' },
  { type:'late-handover',  title:'📥 ยังไม่รับกะจากบ่ายเมื่อวาน · ทดสอบ',  body:'เปิดร้านแล้ว รับกะก่อนเริ่มขายนะคะ ☀️' },
  { type:'daily-summary',  title:'📊 สรุปวัน · ทดสอบ',                     body:'💰 รายได้ ฿9,331 · 📦 ต้นทุน ฿4,552 (48.8% 🔴)' },
]

let n = 0
const TOTAL = HUB.length + 1
console.log(`\n🚀 ยิงทดสอบ ${TOTAL} ชนิด — ล็อกจอมือถือ Owner ไว้รอเลย\n`)

for (const t of HUB) {
  n++
  const id = `TEST_${Date.now()}_${n}`
  await setDoc(doc(db, 'hub_notifications', id), {
    source:'system', app:'test', type:t.type, title:t.title, body:t.body,
    createdAt: serverTimestamp(), read:false, read_by:[],
  })
  try {
    const r = await sendHubPush({ notifId: id })
    console.log(`[${n}/${TOTAL}] ${t.title}  →  sent=${r.data?.sent ?? '?'}`)
  } catch (e) { console.log(`[${n}/${TOTAL}] ${t.title}  →  ❌ ${e.message}`) }
  await deleteDoc(doc(db, 'hub_notifications', id)).catch(() => {})   // ลบ test doc ออกจากฟีด (push ส่งไปแล้ว)
  await wait(2500)
}

// ── Maintenance push (Mtn_push_tokens) — notifyTaskDone ──
n++
try {
  const r = await notifyTaskDone({ branchId: BRANCH_509, catalogName:'ทดสอบงานเสร็จ', doneByName:'ระบบทดสอบ' })
  console.log(`[${n}/${TOTAL}] ✅ งานเสร็จ (Maintenance)  →  sent=${r.data?.sent ?? '?'}`)
} catch (e) { console.log(`[${n}/${TOTAL}] notifyTaskDone  →  ❌ ${e.message}`) }

console.log(`\nℹ️  dailyReminder (08:00) ใช้ช่องเดียวกับ notifyTaskDone (Mtn_push_tokens) → ถ้า [${n}] เด้ง = ช่องนี้โอเค`)
console.log('✅ ยิงครบ — ปลดล็อกจอเช็คว่าเด้งกี่อัน (Hub 6 + Maintenance 1)\n')
process.exit(0)
