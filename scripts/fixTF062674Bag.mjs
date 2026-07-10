/**
 * fixTF062674Bag — แก้ผลพวงใบโอน TF-06.26-74 ที่โอน "8 มัด" แต่ระบบขยับแค่ 8 ใบ
 *   ที่ถูก: 8 มัด × 25 = 200 ใบ → ขยับน้อยไป 192 ใบ ทั้ง 2 ฝั่ง
 *   แก้:  คลังกลาง −192 ใบ (FIFO หัก LOT) · สาขา 509 +192 ใบ (สร้าง LOT)
 *   พร้อม sync LOT + movement + audit (เหมือนปรับยอดในแอป v2.5 — ไม่สร้าง drift)
 *
 * READ-ONLY by default · รันจริง: node scripts/fixTF062674Bag.mjs --commit
 */
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs, doc, getDoc, writeBatch, serverTimestamp, increment } from 'firebase/firestore'

const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)
const COMMIT = process.argv.includes('--commit')

const ITEM = 'fjXFeoma8Wf0V6mbfGBz'   // ถุงเก็บอุณหภูมิ 2 แก้ว
const ADJ  = 192                       // ใบ ที่ต้องชดเชย
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })

const whs = (await getDocs(collection(db,'Inv_warehouses'))).docs.map(d=>({id:d.id,...d.data()}))
const main = whs.find(w => w.type==='main' || w.isMain)
const br   = whs.find(w => w.name === 'Mixue - 509')
if (!main || !br) { console.log('❌ ไม่พบคลัง', {main:main?.name, br:br?.name}); process.exit(0) }

const lots = (await getDocs(collection(db,'Inv_lots'))).docs.map(d=>({id:d.id,...d.data()}))
  .filter(l => l.itemId===ITEM && l.status!=='split')
const getAvail = (l,wh) => (l.locationQty && typeof l.locationQty==='object') ? (Number(l.locationQty[wh])||0) : (l.warehouseId===wh ? (Number(l.inWarehouse)||0) : 0)
const parseD = s => !s ? null : (s.includes('-') ? new Date(s) : null)

// แผนหัก FIFO ที่คลังกลาง
const mainLots = lots.filter(l => getAvail(l, main.id) > 0).sort((a,b)=>(parseD(a.receiveDate)||0)-(parseD(b.receiveDate)||0))
let remain = ADJ; const cuts = []
for (const l of mainLots) { if (remain<=0) break; const t=Math.min(getAvail(l,main.id),remain); if(t>0){cuts.push({l,t});remain-=t} }

const mb = await getDoc(doc(db,'Inv_stock_balances',`${main.id}_${ITEM}`))
const bb = await getDoc(doc(db,'Inv_stock_balances',`${br.id}_${ITEM}`))
console.log(`mode = ${COMMIT?'🔴 COMMIT':'🟢 DRY-RUN'}`)
console.log(`\nคลังกลาง: ${Number(mb.data()?.qty||0)} → ${Number(mb.data()?.qty||0)-ADJ} ใบ  (−${ADJ})`)
console.log(`  FIFO หัก LOT: ${cuts.map(c=>`#${c.l.id.slice(-6)}(รับ ${c.l.receiveDate||'-'}) −${c.t}`).join(', ')||'(ไม่มี LOT — หัก balance อย่างเดียว)'}`)
if (remain>0) console.log(`  ⚠️ LOT คลังกลางไม่พอ ${remain} ใบ — จะหัก balance เต็ม ${ADJ} แต่ LOT ขาด (reconciler จะเห็น)`)
console.log(`สาขา 509: ${Number(bb.data()?.qty||0)} → ${Number(bb.data()?.qty||0)+ADJ} ใบ  (+${ADJ})`)
console.log(`  + สร้าง LOT ใหม่ที่สาขา 192 ใบ (source: แก้ TF-06.26-74)`)

if (!COMMIT) { console.log('\n🟢 DRY-RUN — รันจริง: node scripts/fixTF062674Bag.mjs --commit'); process.exit(0) }

const batch = writeBatch(db)
// คลังกลาง −192 (balance + FIFO LOT)
batch.set(doc(db,'Inv_stock_balances',`${main.id}_${ITEM}`), { qty: increment(-ADJ), lastUpdated: serverTimestamp() }, { merge:true })
for (const c of cuts) {
  const upd = { used: increment(c.t), lastUpdated: serverTimestamp() }
  if (c.l.locationQty) upd[`locationQty.${main.id}`] = Math.max(0,(Number(c.l.locationQty[main.id])||0)-c.t)
  if (typeof c.l.inWarehouse!=='undefined' || !c.l.locationQty) upd.inWarehouse = Math.max(0,(Number(c.l.inWarehouse)||0)-c.t)
  batch.update(doc(db,'Inv_lots',c.l.id), upd)
}
batch.set(doc(collection(db,'Inv_stock_movements')), { type:'adjust', itemId:ITEM, itemName:'ถุงเก็บอุณหภูมิ 2 แก้ว', warehouseId:main.id, qty:-ADJ, qtyUse:-ADJ, unit:'ใบ', unitUse:'ใบ', adjustReason:'แก้โอนผิดหน่วย TF-06.26-74 (8 มัด=200 ใบ)', staffName:'system-fix', timestamp:serverTimestamp() })
// สาขา +192 (balance + LOT ใหม่)
batch.set(doc(db,'Inv_stock_balances',`${br.id}_${ITEM}`), { qty: increment(ADJ), unit:'ใบ', lastUpdated: serverTimestamp() }, { merge:true })
batch.set(doc(collection(db,'Inv_lots')), { itemId:ITEM, itemName:'ถุงเก็บอุณหภูมิ 2 แก้ว', warehouseId:br.id, receiveDate:today, expDate:'', pendingInfo:false, qty:ADJ, locationQty:{[br.id]:ADJ}, totalQty:ADJ, inWarehouse:ADJ, inShop:0, used:0, source:'แก้ TF-06.26-74', status:'active', createdAt:serverTimestamp() })
batch.set(doc(collection(db,'Inv_stock_movements')), { type:'adjust', itemId:ITEM, itemName:'ถุงเก็บอุณหภูมิ 2 แก้ว', warehouseId:br.id, qty:ADJ, qtyUse:ADJ, unit:'ใบ', unitUse:'ใบ', adjustReason:'แก้โอนผิดหน่วย TF-06.26-74 (8 มัด=200 ใบ)', staffName:'system-fix', timestamp:serverTimestamp() })
batch.set(doc(collection(db,'Inv_audit_logs')), { action:'adjust_stock', staffName:'system-fix', detail:`แก้ TF-06.26-74: คลังกลาง −${ADJ} / สาขา509 +${ADJ} ใบ (8 มัด=200 ใบ)`, timestamp:serverTimestamp() })
await batch.commit()
console.log('\n🔴 COMMITTED')
process.exit(0)
