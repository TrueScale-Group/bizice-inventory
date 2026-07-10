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

const ref = process.argv[2] || 'PO-06.26-37'
const all = await getDocs(collection(db, 'Inv_purchase_orders'))
const found = all.docs.find(d => d.data().poRef === ref)
if (!found) { console.log('not found:', ref); process.exit(0) }
const po = found.data()
console.log(`🛒 ${po.poRef} | status=${po.status} | supplier=${po.supplier} | docId=${found.id}`)
console.log(`   createdBy=${po.createdBy} editedBy=${po.editedBy || '-'}`)
console.log(`   items=${(po.items||[]).length}`)
let total = 0
;(po.items||[]).forEach((it, i) => {
  total += parseFloat(it.qty) || 0
  console.log(`   [${String(i).padStart(2)}] ${it.itemName.padEnd(22)} qty=${JSON.stringify(it.qty)} unit=${it.unit} fulfilledUse=${it.fulfilledQtyUse} cat=${it.category}`)
})
console.log(`   TOTAL qty (sum) = ${total}`)
process.exit(0)
