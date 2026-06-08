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

const snap = await getDocs(collection(db, 'Inv_transfers'))
const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
all.sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0))

console.log(`Total transfers: ${all.length}`)
console.log('\nLast 5:')
all.slice(0,5).forEach(tf => {
  const ca = tf.createdAt?.seconds ? new Date(tf.createdAt.seconds*1000).toISOString() : '-'
  const ra = tf.receivedAt?.seconds ? new Date(tf.receivedAt.seconds*1000).toISOString() : '-'
  console.log(`  ${tf.tfRef||tf.id.slice(-8)} [${tf.status}] created=${ca} received=${ra} ${tf.fromWarehouseName}→${tf.toWarehouseName} items=${tf.items?.length||0}`)
})
process.exit(0)
