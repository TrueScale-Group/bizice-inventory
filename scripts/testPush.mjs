// testPush.mjs — ยิง push ทดสอบจริงผ่าน Cloud Function sendHubPush
// สร้าง test doc ใน hub_notifications แล้วเรียก function → push เข้ามือถือ owner/admin
// ใช้ตรวจว่า noti เด้ง "อันเดียว" (cone) หลัง deploy data-only fix
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'

const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)
const functions = getFunctions(app, 'asia-southeast1')

const docId = 'TEST_' + Date.now()
console.log('สร้าง test notification:', docId)
await setDoc(doc(db, 'hub_notifications', docId), {
  source: 'system', app: 'income', type: 'test',
  title: '🧪 ทดสอบ noti ไม่ซ้อน',
  body: 'ถ้าเห็นอันเดียว (ไอคอนไอติม) = แก้สำเร็จ ✅',
  createdAt: serverTimestamp(), read: false, read_by: [],
})

console.log('เรียก Cloud Function sendHubPush ...')
try {
  const fn = httpsCallable(functions, 'sendHubPush')
  const res = await fn({ notifId: docId })
  console.log('ผลลัพธ์:', JSON.stringify(res.data))
} catch (e) {
  console.log('เรียก function ไม่สำเร็จ:', e.message || e)
}

// ลบ test doc ออกจาก feed (push ส่งไปแล้ว ไม่ต้องเก็บ)
await deleteDoc(doc(db, 'hub_notifications', docId)).catch(() => {})
console.log('ลบ test doc ออกจาก feed แล้ว — เช็คมือถือว่าเด้งกี่อัน')
process.exit(0)
