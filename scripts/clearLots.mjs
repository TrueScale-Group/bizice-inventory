import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs, writeBatch, doc } from 'firebase/firestore'

const app = initializeApp({
  apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain: 'mixue-cost-manager.firebaseapp.com',
  projectId: 'mixue-cost-manager',
  storageBucket: 'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId: '1:414432707376:web:1cf394f174257a86cdbef5',
})
const db = getFirestore(app)

const snap = await getDocs(collection(db, 'Inv_lots'))
console.log(`Found ${snap.size} LOT docs`)
if (snap.size === 0) process.exit(0)

let batch = writeBatch(db)
let n = 0
for (const d of snap.docs) {
  batch.delete(doc(db, 'Inv_lots', d.id))
  n++
  if (n % 400 === 0) { await batch.commit(); batch = writeBatch(db) }
}
await batch.commit()
console.log(`✅ Deleted ${n} LOT docs`)
process.exit(0)
