import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore'

const app = initializeApp({
  apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain: 'mixue-cost-manager.firebaseapp.com',
  projectId: 'mixue-cost-manager',
  storageBucket: 'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId: '1:414432707376:web:1cf394f174257a86cdbef5',
})
const db = getFirestore(app)

const snap = await getDoc(doc(db, 'Inv_transfers', 'TF-06.26-98'))
let data
if (snap.exists()) data = snap.data()
else {
  // หาโดย tfRef
  const all = await getDocs(collection(db, 'Inv_transfers'))
  const found = all.docs.find(d => d.data().tfRef === 'TF-06.26-98')
  data = found?.data()
}
if (!data) { console.log('not found'); process.exit(0) }

console.log(`📋 ${data.tfRef}`)
console.log(`   ${data.fromWarehouseName} → ${data.toWarehouseName}`)
console.log(`   สร้าง: ${new Date(data.createdAt.seconds*1000).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })} โดย ${data.createdBy}`)
if (data.driver) console.log(`   คนนำส่ง: ${data.driver}`)
if (data.receivedAt) console.log(`   รับเมื่อ: ${new Date(data.receivedAt.seconds*1000).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })} โดย ${data.receivedBy}`)
console.log(`   สถานะ: ${data.status}`)
console.log(`\n   รายการ (${data.items?.length || 0}):`)
;(data.items || []).forEach((it, i) => {
  console.log(`     ${i+1}. ${it.itemName} — ${it.qty} ${it.unit}`)
})
process.exit(0)
