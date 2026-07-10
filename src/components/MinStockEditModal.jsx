import { useState, useEffect } from 'react'
import { db } from '../firebase'
import { writeBatch, doc, serverTimestamp } from 'firebase/firestore'
import { Modal } from './Modal'
import { COL } from '../constants/collections'
import { balanceId } from '../utils/unit'
import { beepSuccess } from '../utils/audio'

/**
 * MinStockEditModal — แก้ minQty แยกตาม warehouse
 * (เก็บใน unitUse เพราะ stock_balances.qty เก็บใน unitUse)
 */
export default function MinStockEditModal({
  open, onClose, item, warehouses = [], balancesMap = {}, onSuccess,
}) {
  const [values, setValues] = useState({})
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open || !item) return
    const init = {}
    warehouses.forEach(w => {
      const bal = balancesMap[balanceId(w.id, item.id)]
      init[w.id] = bal?.minQty || 0
    })
    setValues(init)
    setErr('')
  }, [open, item?.id, warehouses.length])

  async function handleSave() {
    if (!item) return
    setLoading(true); setErr('')
    try {
      const batch = writeBatch(db)
      const now = serverTimestamp()
      warehouses.forEach(w => {
        const min = parseFloat(values[w.id]) || 0
        const ref = doc(db, COL.STOCK_BALANCES, balanceId(w.id, item.id))
        batch.set(ref, {
          warehouseId: w.id,
          itemId:      item.id,
          minQty:      min,
          unit:        item.unitUse || '',
          lastUpdated: now,
        }, { merge: true })
      })
      await batch.commit()
      beepSuccess()
      onSuccess?.(`✅ บันทึก min stock ${item.name} เรียบร้อย`)
      onClose?.()
    } catch (e) {
      setErr(e.message || 'เกิดข้อผิดพลาด')
    } finally {
      setLoading(false)
    }
  }

  if (!item) return null

  return (
    <Modal open={open} onClose={() => { if (!loading) onClose?.() }}
      title={`ตั้งค่า stock ขั้นต่ำ — ${item.name}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 12px' }}>
        <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A',
          borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#92400E' }}>
          💡 เมื่อ stock ต่ำกว่านี้ จะขึ้น badge สีเหลือง/แดง และแจ้งเตือนค่ะ
          <div style={{ marginTop: 4, fontSize: 11, color: '#92400E', opacity: 0.85 }}>
            หน่วย: <strong>{item.unitUse}</strong> ทุกคลัง (เก็บใน DB ที่หน่วยเดียวกัน)
          </div>
        </div>

        {warehouses.map(w => (
          <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--txt)' }}>{w.name}</div>
            <input type="number" inputMode="decimal" value={values[w.id] ?? 0}
              onChange={e => setValues(v => ({ ...v, [w.id]: e.target.value }))}
              min="0" step="any"
              style={{ width: 100, padding: '8px 12px', borderRadius: 10,
                border: '1.5px solid var(--border2)', fontSize: 14, fontWeight: 600,
                textAlign: 'right' }}/>
            <span style={{ fontSize: 12, color: 'var(--txt3)', minWidth: 50 }}>{item.unitUse}</span>
          </div>
        ))}

        {err && (
          <div style={{ background: '#FEE2E2', color: '#DC2626', padding: '8px 12px',
            borderRadius: 8, fontSize: 12, fontWeight: 600 }}>{err}</div>
        )}

        <button onClick={handleSave} disabled={loading}
          style={{ padding: '12px 16px', border: 'none', borderRadius: 12,
            background: loading ? 'var(--border2)' : 'var(--red)', color: '#fff',
            fontSize: 14, fontWeight: 700, cursor: loading ? 'wait' : 'pointer' }}>
          {loading ? 'กำลังบันทึก...' : '✓ บันทึก'}
        </button>
      </div>
    </Modal>
  )
}
