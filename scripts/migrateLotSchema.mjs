/**
 * migrateLotSchema — backfill ให้ทุก LOT มี "ทั้ง 2 schema" สอดคล้องกัน (V4 · P1)
 *   schema A: inWarehouse/inShop/totalQty/used
 *   schema B: qty/locationQty
 *
 * READ-ONLY by default → พิมพ์รายงานว่าจะแก้อะไรบ้าง
 * รันจริงด้วย:  node scripts/migrateLotSchema.mjs --commit
 */
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs, doc, writeBatch } from 'firebase/firestore'

const app = initializeApp({
  apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain: 'mixue-cost-manager.firebaseapp.com',
  projectId: 'mixue-cost-manager',
  storageBucket: 'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId: '1:414432707376:web:1cf394f174257a86cdbef5',
})
const db = getFirestore(app)
const COMMIT = process.argv.includes('--commit')

const snap = await getDocs(collection(db, 'Inv_lots'))
console.log(`total LOT docs = ${snap.size} · mode = ${COMMIT ? '🔴 COMMIT' : '🟢 DRY-RUN'}\n`)

const sumLoc = m => Object.values(m || {}).reduce((s, v) => s + (Number(v) || 0), 0)
let plan = [], skipSplit = 0, alreadyOk = 0

for (const d of snap.docs) {
  const l = d.data()
  if (l.status === 'split') { skipSplit++; continue }
  const hasLoc = l.locationQty && typeof l.locationQty === 'object' && Object.keys(l.locationQty).length > 0
  const hasIW  = typeof l.inWarehouse !== 'undefined'
  const patch = {}

  if (hasIW && !hasLoc) {
    // schema A → เติม locationQty/qty
    const iw = Number(l.inWarehouse) || 0
    const wh = l.warehouseId || '__main__'
    patch.locationQty = { [wh]: iw }
    patch.qty = iw
  } else if (hasLoc && !hasIW) {
    // schema B → เติม inWarehouse/totalQty/used
    const total = sumLoc(l.locationQty)
    patch.inWarehouse = total
    patch.inShop = Number(l.inShop) || 0
    patch.totalQty = Number(l.totalQty) || total
    patch.used = Number(l.used) || 0
  }

  if (Object.keys(patch).length === 0) { alreadyOk++; continue }
  plan.push({ id: d.id, name: l.itemName, patch })
}

console.log(`✅ ครบ 2 schema แล้ว: ${alreadyOk} · ⏭️ split (ข้าม): ${skipSplit} · 🔧 ต้องแก้: ${plan.length}\n`)
plan.slice(0, 40).forEach(p => console.log(`  ${p.id.slice(0, 28).padEnd(28)} ${(p.name || '').padEnd(20)} ${JSON.stringify(p.patch)}`))
if (plan.length > 40) console.log(`  ...อีก ${plan.length - 40} รายการ`)

if (!COMMIT) { console.log('\n🟢 DRY-RUN — ไม่ได้เขียนอะไร · รันจริง: node scripts/migrateLotSchema.mjs --commit'); process.exit(0) }

let batch = writeBatch(db), n = 0, committed = 0
for (const p of plan) {
  batch.set(doc(db, 'Inv_lots', p.id), p.patch, { merge: true })
  if (++n >= 400) { await batch.commit(); committed += n; batch = writeBatch(db); n = 0 }
}
if (n > 0) { await batch.commit(); committed += n }
console.log(`\n🔴 COMMITTED ${committed} docs`)
process.exit(0)
