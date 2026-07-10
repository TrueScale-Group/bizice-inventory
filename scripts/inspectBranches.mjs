// inspectBranches.mjs — ตรวจสุขภาพ Inv_warehouses หลังย้ายจัดการสาขาไป Hub
// READ-ONLY: ใช้ getDocs อย่างเดียว ไม่เขียน/ลบอะไรทั้งสิ้น
//
// เช็ค:
//   1) รายการคลังทั้งหมด + คลังซ้ำ (ชื่อเดียวกันหลาย doc)
//   2) ข้อมูลที่อ้าง warehouseId ไหน (balances/cut_logs/transfers/refills/movements)
//      → แยกเป็น: คลัง active · คลังถูกลบ (active:false) · ⚠️ orphan (ไม่มีคลังนี้เลย)
//
// รัน:  node scripts/inspectBranches.mjs
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs } from 'firebase/firestore'

const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)

const load = async (name) => (await getDocs(collection(db, name))).docs.map(d => ({ id: d.id, ...d.data() }))

// ── 1) Warehouses ───────────────────────────────────────────────
const whs = await load('Inv_warehouses')
const whMap = {}            // id → doc
whs.forEach(w => { whMap[w.id] = w })
const whName = (id) => {
  if (!id) return '(ว่าง)'
  const w = whMap[id]
  if (!w) return `⚠️ ORPHAN(${id})`
  return `${w.name}${w.active === false ? ' [ลบแล้ว]' : ''}`
}

console.log('\n══════════ 1) คลังทั้งหมดใน Inv_warehouses ══════════')
console.log(`รวม ${whs.length} docs (active ${whs.filter(w => w.active !== false).length} · ลบแล้ว ${whs.filter(w => w.active === false).length})\n`)
whs.sort((a, b) => (b.active !== false) - (a.active !== false))
  .forEach(w => {
    console.log(`  ${w.active === false ? '🗑️ ' : '✅ '}${(w.name || '(ไม่มีชื่อ)').padEnd(20)} | type=${(w.type || '-').padEnd(7)} isMain=${!!w.isMain} | id=${w.id}`)
  })

// ── 2) คลังชื่อซ้ำ ──────────────────────────────────────────────
const byName = {}
whs.forEach(w => { const k = (w.name || '').trim(); (byName[k] = byName[k] || []).push(w) })
const dups = Object.entries(byName).filter(([, arr]) => arr.length > 1)
console.log('\n══════════ 2) คลังชื่อซ้ำ (อาจเกิดจาก Hub สร้างใหม่ทับของเดิม) ══════════')
if (dups.length === 0) console.log('  ✅ ไม่มีชื่อซ้ำ')
else dups.forEach(([name, arr]) => {
  console.log(`  ⚠️ "${name}" มี ${arr.length} docs:`)
  arr.forEach(w => console.log(`       id=${w.id} · active=${w.active !== false} · type=${w.type}`))
})

// ── 3) นับการอ้าง warehouseId ในแต่ละ collection ────────────────
async function audit(colName, fields) {
  const rows = await load(colName)
  const counts = {}   // refId → n
  for (const r of rows) {
    for (const f of fields) {
      const id = r[f]
      if (id == null || id === '') continue
      counts[id] = (counts[id] || 0) + 1
    }
  }
  return { total: rows.length, counts }
}

const targets = [
  ['Inv_stock_balances', ['warehouseId']],
  ['Inv_cut_logs',       ['warehouseId']],
  ['Inv_stock_movements',['warehouseId']],
  ['Inv_transfers',      ['fromWarehouseId', 'toWarehouseId']],
  ['Inv_refill_requests',['branchId']],
]

console.log('\n══════════ 3) ข้อมูลอ้างคลังไหนบ้าง (⚠️ ORPHAN = ไม่มีคลังนั้น) ══════════')
let orphanFound = false
for (const [colName, fields] of targets) {
  let res
  try { res = await audit(colName, fields) }
  catch (e) { console.log(`\n  ${colName}: อ่านไม่ได้ (${e.message})`); continue }
  console.log(`\n  📂 ${colName} (${res.total} docs · field: ${fields.join(', ')})`)
  const entries = Object.entries(res.counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) { console.log('       (ไม่มีการอ้าง warehouse)'); continue }
  for (const [refId, n] of entries) {
    const isOrphan = !whMap[refId]
    if (isOrphan) orphanFound = true
    console.log(`       ${isOrphan ? '⚠️ ' : '   '}${whName(refId).padEnd(28)} → ${n} รายการ`)
  }
}

// ── สรุป ────────────────────────────────────────────────────────
console.log('\n══════════ สรุป ══════════')
console.log(dups.length > 0 ? '  ⚠️ พบคลังชื่อซ้ำ — ตรวจว่าเป็นของเดิม vs Hub สร้างใหม่' : '  ✅ ไม่มีคลังซ้ำ')
console.log(orphanFound
  ? '  ⚠️ พบข้อมูลผูกกับ warehouseId ที่ไม่มีคลังแล้ว (orphan) → ต้อง map id เก่า→ใหม่ ก่อนข้อมูลจะโผล่ครบ'
  : '  ✅ ไม่มี orphan — ทุกข้อมูลผูกกับคลังที่ยังมีอยู่ (ไม่ต้อง migrate)')
console.log('')
process.exit(0)
