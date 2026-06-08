// Merge duplicate balance docs:
//   keeper = doc id matches `${warehouseId}_${itemId}` (correct V2 pattern)
//   legacy = the other (itemId_warehouseId)
// Action: keeper.qty += legacy.qty; keeper.minQty = max; then delete legacy

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

const snap = await getDocs(collection(db, 'Inv_stock_balances'))
const grouped = {}
snap.docs.forEach(d => {
  const data = d.data()
  const key = `${data.warehouseId}__${data.itemId}`
  if (!grouped[key]) grouped[key] = []
  grouped[key].push({ id: d.id, ...data })
})

const batch = writeBatch(db)
let mergedCount = 0

for (const [key, docs] of Object.entries(grouped)) {
  if (docs.length <= 1) continue
  const [whId, itemId] = key.split('__')
  const expectedKeeperId = `${whId}_${itemId}`

  const keeper = docs.find(d => d.id === expectedKeeperId)
  const legacies = docs.filter(d => d.id !== expectedKeeperId)
  if (!keeper) {
    console.log(`⚠️ Skip ${key} — no keeper found (none has expected id)`)
    continue
  }

  const totalQty = docs.reduce((s, d) => s + (Number(d.qty) || 0), 0)
  const maxMin   = docs.reduce((m, d) => Math.max(m, Number(d.minQty) || 0), 0)

  console.log(`📦 ${itemId} @ ${whId}: merge → keeper qty=${totalQty} minQty=${maxMin}, delete ${legacies.length} legacy`)

  batch.update(doc(db, 'Inv_stock_balances', keeper.id), {
    qty: totalQty,
    ...(maxMin > 0 ? { minQty: maxMin } : {}),
    lastUpdated: serverTimestamp(),
    mergedFromLegacy: true,
  })
  for (const lg of legacies) {
    batch.delete(doc(db, 'Inv_stock_balances', lg.id))
  }
  mergedCount++
}

if (mergedCount === 0) {
  console.log('✅ No duplicates to merge')
  process.exit(0)
}

await batch.commit()
console.log(`\n✅ Done: merged ${mergedCount} pairs`)
process.exit(0)
