// อ่านสรุปกิจกรรมประจำวันที่ระบุ จาก Firestore
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

const DATE = '2026-06-02'
const start = new Date(DATE + 'T00:00:00')
const end   = new Date(DATE + 'T23:59:59')
const inRange = ts => {
  const s = ts?.seconds || 0
  if (!s) return false
  const ms = s * 1000
  return ms >= start.getTime() && ms <= end.getTime()
}
const t = ts => {
  if (!ts?.seconds) return '-'
  const d = new Date(ts.seconds * 1000)
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

const [cut, waste, transfers, refills, adjust, audit, recv] = await Promise.all([
  getDocs(collection(db, 'Inv_cut_logs')),
  getDocs(collection(db, 'Inv_waste_logs')),
  getDocs(collection(db, 'Inv_transfer_orders')),
  getDocs(collection(db, 'Inv_refill_requests')),
  getDocs(collection(db, 'Inv_stock_movements')),
  getDocs(collection(db, 'Inv_audit_logs')),
  getDocs(collection(db, 'Inv_receive_logs')),
])

const cutLogs   = cut.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => inRange(l.timestamp))
const wasteLogs = waste.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => inRange(l.timestamp))
const tfs       = transfers.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => inRange(l.createdAt) || inRange(l.receivedAt))
const rfs       = refills.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => inRange(l.requestedAt) || inRange(l.createdAt))
const adjLogs   = adjust.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => inRange(l.timestamp) && l.type === 'adjust')
const auditLogs = audit.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => inRange(l.timestamp))

console.log(`\n📊 รายงานประจำวันที่ ${DATE}\n${'='.repeat(60)}`)

// ── ตัดสต็อก ──
const activeCuts = cutLogs.filter(c => !c.cancelled && !c.deletedAt)
const totalCost  = activeCuts.reduce((s, l) => s + (l.totalCost || 0), 0)
const totalItems = activeCuts.reduce((s, l) => s + (l.items?.length || 0), 0)
console.log(`\n✂️  ตัดสต็อก: ${activeCuts.length} ใบ · ${totalItems} รายการ · ฿${totalCost.toFixed(2)}`)
const byStaff = {}
activeCuts.forEach(c => { byStaff[c.staffName||'?'] = (byStaff[c.staffName||'?']||0)+1 })
Object.entries(byStaff).forEach(([s,n]) => console.log(`     · ${s}: ${n} ใบ`))
activeCuts.slice(0,5).forEach(c => {
  console.log(`     ${t(c.timestamp)} ${c.staffName} — ${c.items?.length||0} รายการ ฿${(c.totalCost||0).toFixed(2)}`)
})
if (activeCuts.length > 5) console.log(`     ...(+${activeCuts.length - 5})`)

// ── ของเสีย ──
const activeWaste = wasteLogs.filter(w => !w.cancelled)
const fruitW = activeWaste.filter(w => w.type === 'fruit_daily')
const closeW = activeWaste.filter(w => w.type === 'closing')
const wCost  = activeWaste.reduce((s,w) => s+(w.totalCost||0), 0)
console.log(`\n🗑️  ของเสีย: ${activeWaste.length} รายการ · ฿${wCost.toFixed(2)}`)
console.log(`     🍋 ผลไม้: ${fruitW.length}  ·  🌙 ปิดร้าน: ${closeW.length}`)
activeWaste.forEach(w => {
  console.log(`     ${t(w.timestamp)} ${w.type==='fruit_daily'?'🍋':'🌙'} ${w.itemName} ${w.qty} ${w.unit} ฿${(w.totalCost||0).toFixed(2)}${w.deductedStock?' [↓stock]':''}`)
})

// ── โอน/รับ ──
console.log(`\n🚚 โอนสินค้า: ${tfs.length} ใบ`)
tfs.forEach(tf => {
  console.log(`     ${tf.tfRef||tf.id.slice(-6)} ${tf.fromWarehouseName} → ${tf.toWarehouseName} [${tf.status}] ${tf.items?.length||0} รายการ`)
})

// ── แจ้งเติม ──
console.log(`\n🧾 แจ้งเติมของ: ${rfs.length} ใบ`)
rfs.forEach(rf => console.log(`     ${rf.tfRef||rf.id.slice(-6)} ${rf.branchName||'-'} [${rf.status}] ${rf.items?.length||0} รายการ`))

// ── ปรับยอด ──
console.log(`\n⚖️  ปรับยอด: ${adjLogs.length} ครั้ง`)
adjLogs.slice(0,8).forEach(a => {
  console.log(`     ${t(a.timestamp)} ${a.staffName} — ${a.itemName} ${a.qty>0?'+':''}${a.qty} ${a.unit} (${a.adjustReason||'-'})`)
})
if (adjLogs.length > 8) console.log(`     ...(+${adjLogs.length - 8})`)

// ── audit canceled / reverted ──
const cancelEvents = auditLogs.filter(a => a.action?.startsWith('cancel'))
if (cancelEvents.length) {
  console.log(`\n↩️  ยกเลิก/ถอย: ${cancelEvents.length} ครั้ง`)
  cancelEvents.forEach(a => console.log(`     ${t(a.timestamp)} ${a.staffName} — ${a.detail||''}`))
}

console.log('\n' + '='.repeat(60))
process.exit(0)
