// หาทุก RF ที่ status='processing' แต่ TF ที่ link อยู่ status='received' แล้ว → อัพเดทเป็น 'done'
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs, doc, writeBatch, serverTimestamp } from 'firebase/firestore'

const app = initializeApp({
  apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain: 'mixue-cost-manager.firebaseapp.com',
  projectId: 'mixue-cost-manager',
  storageBucket: 'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId: '1:414432707376:web:1cf394f174257a86cdbef5',
})
const db = getFirestore(app)

const [rfSnap, tfSnap] = await Promise.all([
  getDocs(collection(db, 'Inv_refill_requests')),
  getDocs(collection(db, 'Inv_transfers')),
])
const tfMap = {}
tfSnap.docs.forEach(d => { tfMap[d.id] = { id: d.id, ...d.data() } })

const batch = writeBatch(db)
let fixed = 0
rfSnap.docs.forEach(d => {
  const rf = { id: d.id, ...d.data() }
  if (rf.status !== 'processing') return
  if (!rf.transferOrderId) return
  const tf = tfMap[rf.transferOrderId]
  if (!tf) return
  if (tf.status === 'received') {
    console.log(`✅ ${rf.rfRef || rf.id.slice(-6)} → ${tf.tfRef} [received] — fixing to done`)
    batch.update(doc(db, 'Inv_refill_requests', rf.id), { status: 'done', completedAt: serverTimestamp(), autoFixed: true })
    fixed++
  } else if (tf.status === 'cancelled') {
    console.log(`↩️ ${rf.rfRef || rf.id.slice(-6)} → ${tf.tfRef} [cancelled] — reverting to pending`)
    batch.update(doc(db, 'Inv_refill_requests', rf.id), { status: 'pending', transferOrderId: null, tfRef: null, autoFixed: true })
    fixed++
  }
})
if (fixed === 0) { console.log('✅ No stale RFs found'); process.exit(0) }
await batch.commit()
console.log(`\n✅ Fixed ${fixed} stale RFs`)
process.exit(0)
