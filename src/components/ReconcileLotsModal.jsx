/**
 * ReconcileLotsModal — 🧩 ปรับ LOT ให้ตรงยอดคงเหลือ (Owner/Admin tool)
 * ─────────────────────────────────────────────────────────────────
 * ปัญหา: Inv_stock_balances (ยอดจริงที่แอพใช้ตัด) กับ Inv_lots (บัญชี LOT) drift กัน
 *   สาเหตุสะสม: ยอดตั้งต้น/Seed ยุคก่อนระบบ LOT ไม่มี LOT คู่ · flow เก่าหัก balance โดยหัก LOT ไม่ครบ ·
 *   unit-drift (LOT ค้างหน่วยเก่า) — ตรวจพบ 6-7 ก.ค. 2569: 107/161 รายการไม่ตรง
 *
 * หลักการซ่อม (balance = source of truth · ไม่แตะ balance เลย):
 *   • LOT ขาด (Σlot < bal)        → สร้าง LOT ใหม่เท่าส่วนต่าง (source: Reconcile · pendingInfo=false กัน alert ท่วม — ใส่ EXP ทีหลังผ่านปุ่มแก้ไขได้)
 *   • LOT เกิน (Σlot > bal)       → หักออกจาก LOT แบบ FIFO (used += ส่วนต่าง) เสมือนการใช้ที่ไม่เคยบันทึกฝั่ง LOT
 *   • สเกลต่างชัด (Σlot > bal×10) → rebuild: เท LOT เก่าทั้งหมดเป็น used แล้วสร้าง LOT ใหม่ = bal
 *   • item ถูกลบจาก Master Data   → ข้าม (balance ตกค้าง — ไม่สร้าง LOT ให้ขยะ)
 * ซ่อมได้ทั้ง "ทีละแถว" และ "ทั้งหมด"
 */
import { useState } from 'react'
import { db } from '../firebase'
import { collection, getDocs, doc, writeBatch, increment, serverTimestamp } from 'firebase/firestore'
import { Modal } from './Modal'
import { COL } from '../constants/collections'
import { getLotAvail, addLot } from '../utils/lotFifo'
import { sortLotsFIFO } from '../utils/fifo'

const BATCH_LIMIT = 400   // Firestore max 500 ops/batch — เผื่อ headroom

export default function ReconcileLotsModal({ open, onClose, items = [], warehouses = [] }) {
  const [phase, setPhase]   = useState('idle')   // idle | scanning | preview | writing
  const [rows, setRows]     = useState([])
  const [status, setStatus] = useState('')
  const [fixedCount, setFixedCount] = useState(0)

  const whName = id => warehouses.find(w => w.id === id)?.name || id

  function reset() { setPhase('idle'); setRows([]); setStatus(''); setFixedCount(0) }

  /* ── 1) สแกน: เทียบ balance กับ Σ LOT active ต่อ (item × คลัง) ── */
  async function scan() {
    setPhase('scanning'); setStatus('กำลังโหลดข้อมูล...')
    try {
      const [balSnap, lotSnap] = await Promise.all([
        getDocs(collection(db, COL.STOCK_BALANCES)),
        getDocs(collection(db, COL.LOT_TRACKING)),
      ])
      const balances = balSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      const lots = lotSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => l.status !== 'split')

      const found = []
      for (const b of balances) {
        const wh = b.warehouseId, iid = b.itemId
        if (!wh || !iid) continue
        const balQty = Number(b.qty) || 0
        const itemLots = lots.filter(l => l.itemId === iid && getLotAvail(l, wh) > 0)
        const lotQty = itemLots.reduce((s, l) => s + getLotAvail(l, wh), 0)
        const diff = lotQty - balQty
        if (Math.abs(diff) < 0.001) continue
        const master = items.find(i => i.id === iid)
        // ข้าม: item ถูกลบจาก Master (balance ตกค้าง) หรือ item ปิดระบบ LOT (lotEnabled=false)
        const orphan = !master || master.lotEnabled === false
        // แผนซ่อม: rebuild เมื่อสเกลต่างกันชัด (หน่วยเก่า) · ไม่งั้นหัก FIFO / เพิ่ม LOT
        const plan = orphan ? 'skip'
          : diff > 0
            ? (balQty >= 0 && lotQty > Math.max(balQty * 10, balQty + 50) ? 'rebuild' : 'consume')
            : 'add'
        found.push({
          iid, wh, balQty, lotQty, diff, plan, lots: itemLots, orphan,
          name: master?.displayName || master?.name || b.itemName || iid,
          unit: master?.unitUse || b.unit || '',
          skipReason: !master ? 'ถูกลบจาก Master' : (master.lotEnabled === false ? 'ปิด LOT' : ''),
        })
      }
      // orphan ไปท้ายสุด · ที่เหลือเรียงชื่อไทย
      found.sort((a, b) => (a.orphan - b.orphan) || a.name.localeCompare(b.name, 'th') || a.wh.localeCompare(b.wh))
      setRows(found)
      setPhase('preview')
      setStatus('')
    } catch (e) {
      setStatus(`❌ ${e.message || 'สแกนไม่สำเร็จ'}`); setPhase('idle')
    }
  }

  /* ── 2) ซ่อม (list ที่เลือก): เขียนเป็น chunk ≤400 ops — แต่ละแถวจบใน chunk เดียว ── */
  async function applyFix(targets) {
    const list = targets.filter(r => !r.orphan)
    if (!list.length) return
    setPhase('writing')
    const sName = window._bizSession?.name || ''
    const phone = window._bizSession?.phone || ''
    let batch = writeBatch(db), ops = 0, done = 0
    let nConsume = 0, nAdd = 0, nRebuild = 0
    const commitIfNeeded = async (need) => {
      if (ops + need > BATCH_LIMIT) { await batch.commit(); batch = writeBatch(db); ops = 0 }
    }
    try {
      for (const r of list) {
        if (r.plan === 'add') {
          await commitIfNeeded(1)
          addLot(batch, {
            itemId: r.iid, itemName: r.name, warehouseId: r.wh,
            qtyUse: -r.diff, source: 'Reconcile: ยอดตั้งต้นไม่มี LOT',
            // pendingInfo:false — กัน alert "รอเพิ่มข้อมูล LOT" ท่วม (ใส่ EXP ทีหลังผ่าน ✏️ แก้ไข ได้)
            extra: { reconcile: true, reconciledBy: sName, pendingInfo: false },
          })
          ops += 1; nAdd++
        } else if (r.plan === 'rebuild') {
          await commitIfNeeded(r.lots.length + 1)
          for (const l of r.lots) {
            const avail = getLotAvail(l, r.wh)
            if (avail <= 0) continue
            const upd = { used: increment(avail), lastUpdated: serverTimestamp(), reconciledAt: serverTimestamp() }
            if (l.locationQty && typeof l.locationQty === 'object') upd[`locationQty.${r.wh}`] = 0
            if (typeof l.inWarehouse !== 'undefined' || !l.locationQty) upd.inWarehouse = 0
            batch.update(doc(db, COL.LOT_TRACKING, l.id), upd); ops++
          }
          if (r.balQty > 0) {
            addLot(batch, {
              itemId: r.iid, itemName: r.name, warehouseId: r.wh,
              qtyUse: r.balQty, source: 'Reconcile: rebuild (LOT เดิมหน่วยเก่า)',
              extra: { reconcile: true, reconciledBy: sName, pendingInfo: false },
            }); ops++
          }
          nRebuild++
        } else {
          // consume: หักส่วนเกินจาก LOT แบบ FIFO (รับก่อนโดนหักก่อน)
          let remain = r.diff
          const cand = sortLotsFIFO(r.lots)
          await commitIfNeeded(cand.length)
          for (const l of cand) {
            if (remain <= 0.0001) break
            const avail = getLotAvail(l, r.wh)
            const take = Math.min(avail, remain)
            if (take <= 0) continue
            const upd = { used: increment(take), lastUpdated: serverTimestamp(), reconciledAt: serverTimestamp() }
            if (l.locationQty && typeof l.locationQty === 'object') upd[`locationQty.${r.wh}`] = avail - take
            if (typeof l.inWarehouse !== 'undefined' || !l.locationQty) upd.inWarehouse = Math.max(0, (Number(l.inWarehouse) || 0) - take)
            batch.update(doc(db, COL.LOT_TRACKING, l.id), upd); ops++
            remain -= take
          }
          nConsume++
        }
        done++
        setStatus(`กำลังซ่อม ${done}/${list.length}...`)
      }
      await commitIfNeeded(1)
      batch.set(doc(collection(db, COL.AUDIT_LOGS)), {
        action: 'reconcile_lots', staffName: sName, staffPhone: phone,
        detail: `🧩 ปรับ LOT ให้ตรงสต็อก ${list.length} รายการ (หัก FIFO ${nConsume} · เพิ่ม LOT ${nAdd} · rebuild ${nRebuild}) — balance ไม่ถูกแตะ`,
        timestamp: serverTimestamp(),
      }); ops++
      await batch.commit()
      // เอาแถวที่ซ่อมแล้วออกจากลิสต์ — เหลือแต่ที่ยังไม่ได้ซ่อม/orphan
      const fixedKeys = new Set(list.map(r => `${r.iid}_${r.wh}`))
      setRows(prev => prev.filter(r => !fixedKeys.has(`${r.iid}_${r.wh}`)))
      setFixedCount(c => c + list.length)
      setStatus(`✅ ซ่อมแล้ว ${list.length} รายการ`)
      setPhase('preview')
    } catch (e) {
      setStatus(`❌ ${e.message || 'เขียนไม่สำเร็จ'} — สแกนใหม่ก่อนลองซ้ำ`)
      setPhase('preview')
    }
  }

  const planLabel = { consume: '➖ หัก FIFO', add: '➕ เพิ่ม LOT', rebuild: '🔄 หน่วยเก่า', skip: '🚫 ข้าม' }
  const planColor = { consume: '#B45309', add: '#15803D', rebuild: '#7C3AED', skip: '#9CA3AF' }
  const fixable = rows.filter(r => !r.orphan)
  const planCount = p => rows.filter(r => r.plan === p).length

  return (
    <Modal open={open} onClose={() => { if (phase !== 'writing') { reset(); onClose() } }}
      title="🧩 ปรับ LOT ให้ตรงสต็อก">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        <div style={{ background: '#EFF6FF', borderRadius: 10, padding: 12, fontSize: 12, color: '#1E40AF', lineHeight: 1.6 }}>
          เทียบ <strong>ยอดคงเหลือจริง</strong> กับ <strong>ยอดในบัญชี LOT</strong> ทุกรายการทุกคลัง
          แล้วปรับฝั่ง LOT ให้ตรง — <strong>ไม่แตะยอดคงเหลือจริงเลย</strong> · ซ่อมทีละแถวหรือทั้งหมดก็ได้
          <div style={{ marginTop: 4, color: '#3730A3' }}>
            LOT ที่สร้างใหม่ยังไม่มีวันหมดอายุ — ใส่ทีหลังได้ที่ปุ่ม ✏️ แก้ไข ใน popup LOT
          </div>
        </div>

        {status && (
          <div style={{ fontSize: 13, fontWeight: 600, color: status.startsWith('❌') ? '#DC2626' : '#15803D' }}>
            {status}
          </div>
        )}

        {(phase === 'idle' || phase === 'scanning') && (
          <button onClick={scan} disabled={phase === 'scanning'}
            style={{ border: 'none', borderRadius: 12, padding: '12px 0', fontSize: 14, fontWeight: 700,
              background: '#2563EB', color: '#fff', cursor: 'pointer', opacity: phase === 'scanning' ? 0.6 : 1 }}>
            {phase === 'scanning' ? '⏳ กำลังสแกน...' : '🔍 สแกนทุกรายการ'}
          </button>
        )}

        {(phase === 'preview' || phase === 'writing') && (
          <>
            {/* สรุปหัวตาราง + chips ตามแผน */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>
                {rows.length === 0
                  ? (fixedCount > 0 ? `✅ ซ่อมครบแล้ว (${fixedCount} รายการ)` : '✅ ตรงกันทุกรายการ')
                  : `เหลือ ${fixable.length} รายการ`}
              </span>
              {['consume', 'add', 'rebuild', 'skip'].map(p => planCount(p) > 0 && (
                <span key={p} style={{ fontSize: 10, fontWeight: 700, color: planColor[p],
                  background: '#F8FAFC', border: `1px solid ${planColor[p]}44`, borderRadius: 20, padding: '2px 8px' }}>
                  {planLabel[p]} {planCount(p)}
                </span>
              ))}
            </div>

            {rows.length > 0 && (
              <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
                {rows.map((r, i) => (
                  <div key={`${r.iid}_${r.wh}`} style={{ display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px', fontSize: 11.5, opacity: r.orphan ? 0.55 : 1,
                    borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {r.name}
                        {r.orphan && (
                          <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 700, color: '#9CA3AF',
                            background: '#F3F4F6', borderRadius: 4, padding: '1px 5px' }}>{r.skipReason}</span>
                        )}
                      </div>
                      <div style={{ color: 'var(--txt3)', fontSize: 10.5 }}>
                        {whName(r.wh)} · จริง <strong>{r.balQty}</strong> / LOT <strong>{r.lotQty}</strong> {r.unit}
                        <span style={{ color: r.diff > 0 ? '#B45309' : '#15803D', fontWeight: 700 }}>
                          {' '}({r.diff > 0 ? `เกิน +${+r.diff.toFixed(2)}` : `ขาด ${+r.diff.toFixed(2)}`})
                        </span>
                      </div>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, color: planColor[r.plan],
                      background: '#F8FAFC', border: `1px solid ${planColor[r.plan]}33`,
                      borderRadius: 6, padding: '2px 6px', flexShrink: 0 }}>
                      {planLabel[r.plan]}
                    </span>
                    {!r.orphan && (
                      <button onClick={() => applyFix([r])} disabled={phase === 'writing'}
                        style={{ border: 'none', borderRadius: 8, padding: '5px 10px', fontSize: 11,
                          fontWeight: 700, background: '#DCFCE7', color: '#15803D', cursor: 'pointer',
                          flexShrink: 0, opacity: phase === 'writing' ? 0.5 : 1 }}>
                        ซ่อม
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={scan} disabled={phase === 'writing'}
                style={{ flex: 1, border: '1.5px solid var(--border2)', borderRadius: 12, padding: '11px 0',
                  fontSize: 13, fontWeight: 700, background: 'var(--surf)', color: 'var(--txt)', cursor: 'pointer' }}>
                🔍 สแกนซ้ำ
              </button>
              {fixable.length > 0 && (
                <button onClick={() => applyFix(fixable)} disabled={phase === 'writing'}
                  style={{ flex: 2, border: 'none', borderRadius: 12, padding: '11px 0', fontSize: 13,
                    fontWeight: 700, background: '#16A34A', color: '#fff', cursor: 'pointer',
                    opacity: phase === 'writing' ? 0.6 : 1 }}>
                  {phase === 'writing' ? '⏳ กำลังซ่อม...' : `✅ ซ่อมทั้งหมด (${fixable.length})`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
