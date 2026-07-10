// inspectIncome.mjs — audit income_records: find phantom-branch docs + verify today
// READ-ONLY: ใช้ getDocs อย่างเดียว ไม่เขียน/ลบอะไรทั้งสิ้น
//
// รัน:  node scripts/inspectIncome.mjs
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs } from 'firebase/firestore'

const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)

const BR_509     = 'OIFG4YmV1xs9RKLiIF22'
const BR_CENTRAL = 'N9DVUuD7HhgPJdQ38TNr'
const TODAY      = '2026-06-21'

const load = async (name) => (await getDocs(collection(db, name))).docs.map(d => ({ id: d.id, ...d.data() }))

const docs = await load('income_records')

// ── categorize ──────────────────────────────────────────────────
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:_(.+))?$/
const cats = {
  'OLD format (no branch)': [],
  '509': [],
  'central': [],
  '⚠️ PHANTOM itu': [],
}
const otherCats = {}   // suffix → [ids]
const malformed = []

for (const d of docs) {
  const m = d.id.match(DATE_RE)
  if (!m) { malformed.push(d); continue }
  const suffix = m[2]
  if (suffix == null)              cats['OLD format (no branch)'].push(d)
  else if (suffix === BR_509)      cats['509'].push(d)
  else if (suffix === BR_CENTRAL)  cats['central'].push(d)
  else if (suffix === 'itu')       cats['⚠️ PHANTOM itu'].push(d)
  else { (otherCats[suffix] = otherCats[suffix] || []).push(d) }
}

// ── 1) count summary ────────────────────────────────────────────
console.log('\n══════════ income_records: COUNT summary ══════════')
console.log(`รวมทั้งหมด ${docs.length} docs\n`)
console.log(`  OLD format (no branch) : ${cats['OLD format (no branch)'].length}`)
console.log(`  509 (_${BR_509}) : ${cats['509'].length}`)
console.log(`  central (_${BR_CENTRAL}) : ${cats['central'].length}`)
console.log(`  ⚠️ PHANTOM itu (_itu) : ${cats['⚠️ PHANTOM itu'].length}`)
const otherTotal = Object.values(otherCats).reduce((a, arr) => a + arr.length, 0)
console.log(`  ⚠️ OTHER (other suffix) : ${otherTotal}`)
for (const [suf, arr] of Object.entries(otherCats)) console.log(`        └─ _${suf} : ${arr.length}`)
if (malformed.length) console.log(`  ⚠️ MALFORMED (no date pattern) : ${malformed.length}`)

// ── helpers ─────────────────────────────────────────────────────
const has = (v) => v !== undefined && v !== null
const fieldExists = (d, f) => has(d[f])
const handshakeStatus = (d, f) => has(d[f]) ? JSON.stringify(d[f]) : '(none)'

function describe(d) {
  const morningTotal   = has(d.morning?.total)   ? `yes (${d.morning.total})`   : 'no'
  const afternoonTotal = has(d.afternoon?.total) ? `yes (${d.afternoon.total})` : 'no'
  console.log(`    id = ${d.id}`)
  console.log(`      morning.total?         : ${morningTotal}`)
  console.log(`      afternoon.total?       : ${afternoonTotal}`)
  console.log(`      morning_recv_event     : ${fieldExists(d, 'morning_recv_event')   ? 'EXISTS' : '(missing)'}`)
  console.log(`      morning_handshake      : ${fieldExists(d, 'morning_handshake')    ? handshakeStatus(d, 'morning_handshake') : '(missing)'}`)
  console.log(`      afternoon_recv_event   : ${fieldExists(d, 'afternoon_recv_event') ? 'EXISTS' : '(missing)'}`)
  console.log(`      afternoon_handshake    : ${fieldExists(d, 'afternoon_handshake')  ? handshakeStatus(d, 'afternoon_handshake') : '(missing)'}`)
}

// ── 2) list phantom + other ─────────────────────────────────────
console.log('\n══════════ ⚠️ PHANTOM itu docs (full list) ══════════')
if (cats['⚠️ PHANTOM itu'].length === 0) console.log('  (none)')
else cats['⚠️ PHANTOM itu'].forEach(describe)

console.log('\n══════════ ⚠️ OTHER docs (full list) ══════════')
if (otherTotal === 0) console.log('  (none)')
else for (const [suf, arr] of Object.entries(otherCats)) {
  console.log(`  ── suffix _${suf} ──`)
  arr.forEach(describe)
}

if (malformed.length) {
  console.log('\n══════════ ⚠️ MALFORMED docs ══════════')
  malformed.forEach(describe)
}

// ── 3) TODAY ────────────────────────────────────────────────────
console.log(`\n══════════ TODAY ${TODAY} — all docs (any suffix) ══════════`)
const todayDocs = docs.filter(d => d.id.startsWith(TODAY))
if (todayDocs.length === 0) console.log('  (no docs for today)')
else todayDocs.forEach(describe)

console.log('')
process.exit(0)
