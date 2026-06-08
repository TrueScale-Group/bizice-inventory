import { initializeApp } from 'firebase/app'
import { getFirestore, collection, query, where, getDocs, orderBy } from 'firebase/firestore'

const app = initializeApp({
  apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain: 'mixue-cost-manager.firebaseapp.com',
  projectId: 'mixue-cost-manager',
  storageBucket: 'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId: '1:414432707376:web:1cf394f174257a86cdbef5',
})
const db = getFirestore(app)

const snap = await getDocs(query(
  collection(db, 'Inv_stock_movements'),
  where('adjustReason', '==', 'Data Sheet Import'),
))
const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
docs.sort((a,b) => (b.timestamp?.seconds||0) - (a.timestamp?.seconds||0))

console.log(`Found ${docs.length} Data Sheet Import movements`)
console.log()

// group by timestamp (round to minute) to identify import batches
const buckets = {}
docs.forEach(d => {
  const t = d.timestamp?.seconds || 0
  const key = Math.floor(t / 60) * 60   // round to minute
  if (!buckets[key]) buckets[key] = []
  buckets[key].push(d)
})

const sortedKeys = Object.keys(buckets).map(Number).sort((a,b) => b - a)
sortedKeys.slice(0, 10).forEach(k => {
  const date = new Date(k * 1000)
  console.log(`📦 ${date.toLocaleString('th-TH')} — ${buckets[k].length} ops`)
})

process.exit(0)
