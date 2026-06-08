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

const snap = await getDocs(collection(db, 'Inv_stock_balances'))
const grouped = {}
snap.docs.forEach(d => {
  const data = d.data()
  const key = `${data.warehouseId}__${data.itemId}`
  if (!grouped[key]) grouped[key] = []
  grouped[key].push({ id: d.id, qty: data.qty, minQty: data.minQty })
})

const items = await getDocs(collection(db, 'Inv_items'))
const itemMap = {}
items.docs.forEach(d => { itemMap[d.id] = d.data().name })
const whs = await getDocs(collection(db, 'Inv_warehouses'))
const whMap = {}
whs.docs.forEach(d => { whMap[d.id] = d.data().name })

console.log('\n🔍 Duplicate balance docs (warehouse_item ที่มี > 1 doc):')
let dupCount = 0
Object.entries(grouped).forEach(([key, docs]) => {
  if (docs.length > 1) {
    const [whId, itemId] = key.split('__')
    const itemName = itemMap[itemId] || itemId
    const whName = whMap[whId] || whId
    const total = docs.reduce((s, d) => s + (d.qty || 0), 0)
    console.log(`\n  📦 ${itemName} @ ${whName} (รวม ${total})`)
    docs.forEach(d => console.log(`    - id=${d.id}  qty=${d.qty}  minQty=${d.minQty}`))
    dupCount++
  }
})
console.log(`\nสรุป: ${dupCount} pair มี duplicate · ${snap.size} docs ทั้งหมด`)
process.exit(0)
