import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs } from 'firebase/firestore'
const app = initializeApp({ apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain: 'mixue-cost-manager.firebaseapp.com', projectId: 'mixue-cost-manager', storageBucket: 'mixue-cost-manager.firebasestorage.app', messagingSenderId: '414432707376', appId: '1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)
const snap = await getDocs(collection(db, 'Inv_refill_requests'))
const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
console.log(`Total RFs: ${all.length}`)
const targets = all.filter(r => r.rfRef === 'RF-05.26-06' || r.rfRef === 'RF-06.26-36')
console.log(`\nTargets:`)
targets.forEach(r => console.log(`  ${r.rfRef} status=${r.status} tfRef=${r.tfRef} doc=${r.id}`))

const byStatus = {}
all.forEach(r => { byStatus[r.status||'?'] = (byStatus[r.status||'?']||0)+1 })
console.log(`\nBy status:`, byStatus)
process.exit(0)
