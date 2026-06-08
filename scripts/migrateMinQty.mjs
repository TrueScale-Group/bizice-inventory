// Migrate stock_balances.minQty:
//   หา balance ที่มี minUnit + minQtyRaw → re-compute minQty (in effective unitUse) ตาม cutLevel + factor
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

const [balSnap, itemSnap] = await Promise.all([
  getDocs(collection(db, 'Inv_stock_balances')),
  getDocs(collection(db, 'Inv_items')),
])

const itemMap = {}
itemSnap.docs.forEach(d => { itemMap[d.id] = { id: d.id, ...d.data() } })

function rawToEff(minUnit, cutLevel, factor, subFact) {
  if (cutLevel === 'buy') {
    if (minUnit === 'buy') return 1
    if (minUnit === 'use') return factor > 0 ? 1 / factor : 1
    if (minUnit === 'sub') return (factor > 0 && subFact > 0) ? 1 / (factor * subFact) : 1
  }
  if (cutLevel === 'use') {
    if (minUnit === 'buy') return factor
    if (minUnit === 'use') return 1
    if (minUnit === 'sub') return subFact > 0 ? 1 / subFact : 1
  }
  if (cutLevel === 'sub') {
    if (minUnit === 'buy') return factor * (subFact || 1)
    if (minUnit === 'use') return subFact || 1
    if (minUnit === 'sub') return 1
  }
  return 1
}

const changes = []
balSnap.docs.forEach(d => {
  const b = { id: d.id, ...d.data() }
  if (!b.minQtyRaw || !b.minUnit) return
  const item = itemMap[b.itemId]
  if (!item) return
  const factor  = Number(item.convBuyToUse) || 1
  const subFact = Number(item.convUseToSub) || 0
  const cutLevel = item.cutLevel || 'use'
  const f = rawToEff(b.minUnit, cutLevel, factor, subFact)
  const newMin = Number((b.minQtyRaw * f).toFixed(6))
  const oldMin = Number(b.minQty) || 0
  if (Math.abs(newMin - oldMin) > 0.0001) {
    changes.push({ id: b.id, name: item.name, cutLevel, minUnit: b.minUnit, rawMin: b.minQtyRaw, factor, subFact, oldMin, newMin })
  }
})

console.log(`\n📋 Preview: ${changes.length} balances ต้อง migrate\n`)
changes.slice(0, 20).forEach(c => {
  console.log(`  ${c.name} | cutLevel=${c.cutLevel} minUnit=${c.minUnit} rawMin=${c.rawMin} factor=${c.factor} subFact=${c.subFact}`)
  console.log(`     min: ${c.oldMin} → ${c.newMin}`)
})
if (changes.length > 20) console.log(`  ...(+${changes.length - 20} เพิ่ม)`)

if (changes.length === 0) { console.log('✅ No changes needed'); process.exit(0) }

console.log('\n⏳ กำลังเขียนการเปลี่ยนแปลง...')
const batch = writeBatch(db)
for (const c of changes) {
  batch.update(doc(db, 'Inv_stock_balances', c.id), {
    minQty: c.newMin,
    lastUpdated: serverTimestamp(),
    minMigrated: true,
  })
}
await batch.commit()
console.log(`✅ Migrated ${changes.length} balance docs`)
process.exit(0)
