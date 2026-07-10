// cleanStaleAlerts.mjs — ลบ alert handover ผิดของ "วันนี้" ที่เด้งก่อนแก้ branch-aware
// SAFETY: ลบเฉพาะ hub_notifications ของวันนี้ที่ type==='late-handover' และ docId เป็น format เก่า
//   (ไม่มี branch suffix) เช่น 2026-06-21_morning_late-send · ไม่แตะข้อมูลจริง
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs, doc, deleteDoc } from 'firebase/firestore'

const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
// docId เก่า (ไม่มี branch suffix) — ตัวที่ฟังก์ชันยิงผิดก่อนแก้
const STALE_SUFFIXES = ['_morning_late-send', '_afternoon_late-send', '_morning_late-recv']

console.log(`\nวันนี้ (Bangkok): ${today}`)
console.log('กำลังสแกน hub_notifications ...\n')

const snap = await getDocs(collection(db, 'hub_notifications'))
const targets = []
snap.forEach((d) => {
  const id = d.id
  const data = d.data()
  if (!id.startsWith(today)) return
  // เก็บเฉพาะ docId เก่า "{today}{suffix}" (ไม่มี branch คั่น) ที่เป็น late-handover
  const isStaleId = STALE_SUFFIXES.some((sfx) => id === today + sfx)
  if (isStaleId && (data.type === 'late-handover' || /late-(send|recv)/.test(id))) {
    targets.push({ id, title: data.title || '', body: (data.body || '').slice(0, 60) })
  }
})

if (!targets.length) {
  console.log('✅ ไม่พบ alert handover ผิดของวันนี้ (อาจถูกอ่าน/ลบไปแล้ว)')
  process.exit(0)
}

console.log(`พบ ${targets.length} รายการที่จะลบ:`)
targets.forEach((t) => console.log(`  🗑️ ${t.id}\n      ${t.title} — ${t.body}...`))

for (const t of targets) {
  await deleteDoc(doc(db, 'hub_notifications', t.id))
}
console.log(`\n✅ ลบเรียบร้อย ${targets.length} รายการ (ลบเฉพาะ alert · ไม่แตะข้อมูลยอด/สต็อก)`)
process.exit(0)
