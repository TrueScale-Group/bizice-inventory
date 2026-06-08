import { useState, useMemo, useEffect } from 'react'
import { Modal } from './Modal'
import { adjustStock, ADJUST_REASONS } from '../utils/adjustStock'
import { parseConvFactor, formatStockQty } from '../utils/unit'
import { beepSuccess } from '../utils/audio'

// หน่วยชั่ง/ตวง — Inventory ซ่อนจากการปรับยอด (ใช้หน่วยนับ เช่น ถุง/ลัง แทน)
const WEIGHT_VOL_UNITS = ['กรัม','กก.','กิโลกรัม','มล.','มิลลิลิตร','ลิตร','ซีซี','cc','ml','g','kg','l','oz','ออนซ์']
const isWeightVolUnit = (name) =>
  WEIGHT_VOL_UNITS.some(u => (name || '').toLowerCase().trim() === u.toLowerCase())

/**
 * AdjustStockModal — Owner-only ปรับยอดคงคลัง
 *
 * Props:
 *   open, onClose, item, currentQty (unitUse), warehouses[], defaultWarehouseId
 *   staffPhone, staffName, onSuccess(msg)
 */
export default function AdjustStockModal({
  open, onClose, item, currentQty = 0, warehouses = [],
  defaultWarehouseId, staffPhone, staffName, onSuccess,
}) {
  const [direction, setDirection] = useState('add')
  const [qtyInput,  setQtyInput]  = useState('')
  const [unitMode,  setUnitMode]  = useState(item?.unitUse || 'use')
  const [warehouseId, setWarehouseId] = useState(defaultWarehouseId || '')
  const [reason, setReason] = useState('')
  const [note,   setNote]   = useState('')
  const [loading, setLoading] = useState(false)
  const [err,     setErr]     = useState('')

  const factor = useMemo(() => parseConvFactor(item?.unitConversion), [item])
  const hasBase = factor > 1 && item?.unitBase && item?.unitBase !== item?.unitUse
  const convSub = Number(item?.convSub) || 0
  const hasSub  = convSub > 0 && item?.unitSub && item?.unitSub !== item?.unitUse

  // unitLevels[] = ทุก level จาก CM (sync เก็บไว้ให้)
  //   factorToUse: 1 ของ level นี้ = N ของ unitUse
  //   ถ้าไม่มี (item รุ่นเก่า) → fallback เป็น base/use/sub
  const unitLevels = useMemo(() => {
    let list
    if (Array.isArray(item?.unitLevels) && item.unitLevels.length > 0) {
      list = item.unitLevels.filter(l => l?.name && Number(l.factorToUse) > 0)
    } else {
      // Fallback (legacy items)
      list = []
      if (hasBase) list.push({ name: item.unitBase, factorToUse: factor })
      list.push({ name: item?.unitUse || '', factorToUse: 1 })
      if (hasSub)  list.push({ name: item.unitSub, factorToUse: 1 / convSub })
      list = list.filter(l => l.name)
    }
    // ซ่อนหน่วยชั่ง/ตวง (กรัม ฯลฯ) — เว้นแต่ Owner เปิด showSubInInventory
    if (item?.showSubInInventory !== true) {
      const filtered = list.filter(l => !isWeightVolUnit(l.name))
      if (filtered.length > 0) list = filtered   // กันเผลอกรองหมดเกลี้ยง
    }
    return list
  }, [item, factor, hasBase, hasSub, convSub])

  // ถ้าหน่วยที่เลือกอยู่ไม่อยู่ใน list (เช่น default ไปโดนหน่วยชั่ง) → รีเซ็ตเป็นหน่วยแรก (ใหญ่สุด)
  useEffect(() => {
    if (unitLevels.length > 0 && !unitLevels.some(l => l.name === unitMode)) {
      setUnitMode(unitLevels[0].name)
    }
  }, [unitLevels, unitMode])

  // จำนวนที่กรอก แปลงเป็น unitUse
  const qtyUseAfterInput = useMemo(() => {
    const n = parseFloat(qtyInput) || 0
    const lv = unitLevels.find(l => l.name === unitMode)
    if (lv) return n * Number(lv.factorToUse || 1)
    // legacy mode names
    if (unitMode === 'base') return n * factor
    if (unitMode === 'sub')  return convSub > 0 ? n / convSub : n
    return n
  }, [qtyInput, unitMode, factor, convSub, unitLevels])

  const preview = useMemo(() => {
    const after = direction === 'add'
      ? currentQty + qtyUseAfterInput
      : currentQty - qtyUseAfterInput
    return Math.max(0, after)
  }, [direction, qtyUseAfterInput, currentQty])

  const reasons = ADJUST_REASONS[direction] || []

  function reset() {
    setDirection('add'); setQtyInput(''); setUnitMode(item?.unitUse || 'use')
    setWarehouseId(defaultWarehouseId || ''); setReason(''); setNote('')
    setErr('')
  }

  async function handleConfirm() {
    setErr('')
    if (!item) { setErr('ไม่พบวัตถุดิบ'); return }
    if (!warehouseId) { setErr('เลือกคลัง'); return }
    if (!(qtyUseAfterInput > 0)) { setErr('จำนวนต้องมากกว่า 0'); return }
    if (!reason) { setErr('กรุณาเลือกสาเหตุ'); return }
    if (direction === 'sub' && qtyUseAfterInput > currentQty) {
      setErr(`ลดได้สูงสุด ${formatStockQty(currentQty, item)}`); return
    }
    setLoading(true)
    try {
      await adjustStock({
        itemId: item.id, itemName: item.name, warehouseId,
        qtyUse: qtyUseAfterInput, direction, reason, item,
        note, staffPhone, staffName,
      })
      beepSuccess()
      onSuccess?.(`✅ ปรับยอด ${item.name} เรียบร้อย`)
      reset()
      onClose?.()
    } catch (e) {
      setErr(e.message || 'เกิดข้อผิดพลาด')
    } finally {
      setLoading(false)
    }
  }

  if (!item) return null
  const unitLabel = unitMode === 'base' ? (item.unitBase || '') : (item.unitUse || '')

  return (
    <Modal open={open} onClose={() => { if (!loading) { reset(); onClose?.() } }} title="ปรับยอดคงคลัง">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 12px' }}>
        {/* Item info + Preview (split 50/50) */}
        {(() => {
          const unitUseLabel = item.unitUse || item.unitBase || ''
          const fmtN = n => Number.isInteger(n) ? n : Number(Number(n).toFixed(2))
          const curFmt = formatStockQty(currentQty, item)
          const curSimple = `${fmtN(currentQty)} ${unitUseLabel}`
          const preFmt = formatStockQty(preview, item)
          const preSimple = `${fmtN(preview)} ${unitUseLabel}`
          return (
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg)',
                borderRadius: 12, padding: '10px 12px', minWidth: 0 }}>
                <span style={{ fontSize: 24, flexShrink: 0 }}>{item.img || '📦'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                    ปัจจุบัน: <strong style={{ color: 'var(--txt2)' }}>{curFmt}</strong>
                  </div>
                  {curFmt !== curSimple && unitUseLabel && (
                    <div style={{ fontSize: 10, color: 'var(--txt3)', marginTop: 1 }}>
                      รวม {fmtN(currentQty)} {unitUseLabel}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ flex: 1, background: direction === 'add' ? '#F0FDF4' : '#FEF2F2',
                border: `1px solid ${direction === 'add' ? '#BBF7D0' : '#FECACA'}`,
                borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column',
                justifyContent: 'center', minWidth: 0 }}>
                <span style={{ fontSize: 11, color: 'var(--txt3)' }}>หลังปรับ จะเหลือ</span>
                <strong style={{ fontSize: 15, color: direction === 'add' ? '#15803D' : '#DC2626',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {preFmt}
                </strong>
                {preFmt !== preSimple && unitUseLabel && (
                  <span style={{ fontSize: 10, color: direction === 'add' ? '#15803D' : '#DC2626', opacity: 0.7 }}>
                    รวม {fmtN(preview)} {unitUseLabel}
                  </span>
                )}
              </div>
            </div>
          )
        })()}

        {/* Direction toggle */}
        <div style={{ display: 'flex', background: 'var(--bg)', borderRadius: 10, padding: 4, gap: 4 }}>
          {['add', 'sub'].map(d => (
            <button key={d} onClick={() => { setDirection(d); setReason('') }}
              style={{
                flex: 1, padding: '8px 12px', border: 'none', borderRadius: 8, cursor: 'pointer',
                background: direction === d ? (d === 'add' ? '#15803D' : '#DC2626') : 'transparent',
                color: direction === d ? '#fff' : 'var(--txt2)',
                fontWeight: 700, fontSize: 13, transition: 'all .15s',
              }}>
              {d === 'add' ? '➕ เพิ่ม' : '➖ ลด'}
            </button>
          ))}
        </div>

        {/* Qty + unit toggle */}
        <div>
          <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>จำนวนที่ปรับ</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'stretch',
              border: '1.5px solid var(--border2)', borderRadius: 10, overflow: 'hidden' }}>
              <button type="button" onClick={() => {
                const v = Math.max(0, (parseFloat(qtyInput) || 0) - 1)
                setQtyInput(String(v))
              }} style={{ width: 48, border: 'none', background: '#FEF2F2', color: '#DC2626',
                fontSize: 22, fontWeight: 700, cursor: 'pointer' }}>−</button>
              <input type="number" value={qtyInput} onChange={e => setQtyInput(e.target.value)}
                min="0" step="any" placeholder="0"
                style={{ flex: 1, width: '50%', padding: '10px 8px', border: 'none', outline: 'none',
                  fontSize: 18, fontWeight: 700, textAlign: 'center',
                  MozAppearance: 'textfield' }}/>
              <button type="button" onClick={() => {
                const v = (parseFloat(qtyInput) || 0) + 1
                setQtyInput(String(v))
              }} style={{ width: 48, border: 'none', background: '#F0FDF4', color: '#15803D',
                fontSize: 22, fontWeight: 700, cursor: 'pointer' }}>+</button>
            </div>
            {unitLevels.length > 1 ? (
              <div style={{ display: 'flex', background: 'var(--bg)', borderRadius: 10, padding: 3, gap: 2, flexWrap: 'wrap' }}>
                {unitLevels.map(lv => (
                  <button key={lv.name} onClick={() => setUnitMode(lv.name)}
                    style={{ padding: '0 10px', minHeight: 32, border: 'none', borderRadius: 8, cursor: 'pointer',
                      background: unitMode === lv.name ? 'var(--red)' : 'transparent',
                      color: unitMode === lv.name ? '#fff' : 'var(--txt2)', fontWeight: 700, fontSize: 12 }}>
                    {lv.name}
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--bg)',
                fontSize: 13, fontWeight: 600, color: 'var(--txt2)' }}>
                {unitLevels[0]?.name || unitLabel}
              </div>
            )}
          </div>
          {qtyInput && unitMode !== item.unitUse && unitMode !== 'use' && (
            <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 4 }}>
              = {Number(qtyUseAfterInput).toFixed(2).replace(/\.?0+$/,'')} {item.unitUse}
            </div>
          )}
        </div>

        {/* Warehouse */}
        <div>
          <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>คลังสินค้า</label>
          <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1.5px solid var(--border2)', fontSize: 14, fontWeight: 600, marginTop: 4 }}>
            <option value="">-- เลือกคลัง --</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>

        {/* Reason */}
        <div>
          <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>
            สาเหตุ <span style={{ color: '#DC2626' }}>*</span>
          </label>
          <select value={reason} onChange={e => setReason(e.target.value)}
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1.5px solid var(--border2)', fontSize: 14, fontWeight: 600, marginTop: 4 }}>
            <option value="">-- เลือกสาเหตุ --</option>
            {reasons.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        {/* Note */}
        <div>
          <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>หมายเหตุ (ถ้ามี)</label>
          <input type="text" value={note} onChange={e => setNote(e.target.value)}
            placeholder="..."
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1.5px solid var(--border2)', fontSize: 13, marginTop: 4 }}/>
        </div>

        {err && (
          <div style={{ background: '#FEE2E2', color: '#DC2626', padding: '8px 12px',
            borderRadius: 8, fontSize: 12, fontWeight: 600 }}>{err}</div>
        )}

        <button onClick={handleConfirm} disabled={loading}
          style={{ padding: '12px 16px', border: 'none', borderRadius: 12,
            background: loading ? 'var(--border2)' : 'var(--red)', color: '#fff',
            fontSize: 14, fontWeight: 700, cursor: loading ? 'wait' : 'pointer' }}>
          {loading ? 'กำลังบันทึก...' : '✓ ยืนยันปรับยอด'}
        </button>
      </div>
    </Modal>
  )
}
