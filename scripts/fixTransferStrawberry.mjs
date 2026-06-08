// One-shot: fix the broken transfer where main wasn't decremented and branch only got 1
// แยมสตรอว์เบอร์รี่ 1 ลัง (= 20 กระป๋อง)
// ก่อนแก้:  main = 3 ลัง (60), 509 = 16 กระป๋อง
// หลังแก้:  main = 2 ลัง (40), 509 = 1 ลัง + 15 กระป๋อง (35)
//   = ย้าย 20 กระป๋องจาก main → 509, แต่ระบบใส่แค่ 1 → ต้องเพิ่มอีก 19 ที่ 509, ลด 20 ที่ main

import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs, query, where, doc, getDoc, writeBatch, serverTimestamp } from 'firebase/firestore'

const app = initializeApp({
  apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain: 'mixue-cost-manager.firebaseapp.com',
  projectId: 'mixue-cost-manager',
  storageBucket: 'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId: '1:414432707376:web:1cf394f174257a86cdbef5',
})
const db = getFirestore(app)

// หา item id ของแยมสตรอว์เบอร์รี่
const itemsSnap = await getDocs(collection(db, 'Inv_items'))
const item = itemsSnap.docs.map(d => ({id: d.id, ...d.data()}))
  .find(i => i.name === 'แยมสตรอว์เบอร์รี่')
if (!item) { console.error('ไม่พบ item'); process.exit(1) }
console.log('Item:', item.name, item.id, 'unitConversion:', item.unitConversion)

// หา warehouses
const whSnap = await getDocs(collection(db, 'Inv_warehouses'))
const wList = whSnap.docs.map(d => ({id: d.id, ...d.data()}))
const main = wList.find(w => w.type === 'main' || w.isMain)
const br   = wList.find(w => w.name === 'Mixue - 509')
console.log('Main:', main?.id, '509:', br?.id)

// อ่านยอดปัจจุบัน
const mainBalRef = doc(db, 'Inv_stock_balances', `${main.id}_${item.id}`)
const brBalRef   = doc(db, 'Inv_stock_balances', `${br.id}_${item.id}`)
const mainSnap = await getDoc(mainBalRef)
const brSnap   = await getDoc(brBalRef)
console.log('Main qty:', mainSnap.data()?.qty, '· 509 qty:', brSnap.data()?.qty)

// ปรับ: main -20 (ลด 1 ลัง), 509 +19 (เพิ่มอีก 19 กระป๋อง เพื่อให้รวม 20)
const batch = writeBatch(db)
batch.update(mainBalRef, {
  qty: Math.max(0, (mainSnap.data()?.qty || 0) - 20),
  lastUpdated: serverTimestamp(),
})
batch.update(brBalRef, {
  qty: (brSnap.data()?.qty || 0) + 19,
  lastUpdated: serverTimestamp(),
})
await batch.commit()
console.log('✅ Fixed: main -20, 509 +19')
process.exit(0)
