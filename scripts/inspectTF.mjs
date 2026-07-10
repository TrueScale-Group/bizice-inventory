import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs } from 'firebase/firestore'
const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)
const ref = process.argv[2] || 'TF-06.26-74'
const snap = await getDocs(collection(db, 'Inv_transfers'))
const f = snap.docs.find(d => d.data().tfRef === ref)
if (!f) { console.log('not found', ref); process.exit(0) }
const tf = f.data()
console.log(`🚚 ${tf.tfRef} ${tf.fromWarehouseName} → ${tf.toWarehouseName} · status=${tf.status}`)
for (const it of (tf.items||[])) {
  if (!(it.itemName||'').includes('ถุงเก็บ')) continue
  console.log(`   ${it.itemName} | qty=${it.qty} unit=${JSON.stringify(it.unit)} lotPick=${it.lotPick||'-'}`)
}
process.exit(0)
