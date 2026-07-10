// NotifBell — กระดิ่งแจ้งเตือน Stock (Live) — Inventory
// อ่านจาก stock_balances + items + warehouses → คำนวณ low/out สด
import { useState, useEffect, useRef } from 'react'
import { useItems } from '../hooks/useItems'
import { useStockBalances, useStockBalancesPassive } from '../hooks/useStock'
import { useSession } from '../hooks/useSession'

export default function NotifBell({ warehouses = [] }) {
  // scope ตาม role: staff เห็นแค่สาขาตัวเอง (App กรอง warehouses เหลือสาขาเดียวอยู่แล้ว) → ดึงสาขาเดียวพอ
  //   owner/admin → 'all' (เห็นทุกสาขา)
  const { isStaff, branch_id } = useSession()
  const balScope = (isStaff() && branch_id) ? branch_id : 'all'
  const [open, setOpen] = useState(false)
  // 🪶 LAZY: เปิด live listener เฉพาะตอนกดดูกระดิ่ง · ปิดแล้วปล่อย (ไม่ถือ listener ค้างทุกหน้า)
  useStockBalances(open ? balScope : null)
  // badge/รายการ: อ่านจาก cache + เกาะ listener หน้าอื่น (เช่นแดชบอร์ด) ฟรี — ไม่บังคับเปิด listener เอง
  const balances = useStockBalancesPassive(balScope)
  const items = useItems()                 // shared singleton — ลด Inv_items reads
  // warehouses มาจาก prop (App) — ตัด listener ซ้ำ
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Compute live alerts
  const mainIds = new Set(warehouses.filter(w => w.type === 'main' || w.isMain).map(w => w.id))
  const liveAlerts = balances
    .filter(b => {
      const wh = warehouses.find(w => w.id === b.warehouseId)
      if (!wh || wh.active === false) return false
      const item = items.find(i => i.id === b.itemId)
      if (item?.alertEnabled === false) return false  // ❌ ปิดแจ้งเตือนรายการนี้
      const min = b.minQty || 0
      return min > 0 && (b.qty || 0) <= min
    })
    .map(b => {
      const item = items.find(i => i.id === b.itemId)
      return {
        id: `${b.warehouseId}_${b.itemId}`,
        itemId: b.itemId, warehouseId: b.warehouseId,
        itemName: item?.displayName || item?.name || b.itemId,
        currentQty: b.qty || 0,
        minQty: b.minQty || 0,
        unit: item?.unitUse || b.unit || '',
        _sort: item?.sortOrder ?? 999,
      }
    })
    .sort((a, b) => {
      if ((a.currentQty <= 0) !== (b.currentQty <= 0)) return a.currentQty <= 0 ? -1 : 1
      return a._sort - b._sort
    })
  const mainAlerts   = liveAlerts.filter(a => mainIds.has(a.warehouseId))
  const branchAlerts = liveAlerts.filter(a => !mainIds.has(a.warehouseId))
  const count = liveAlerts.length

  const renderAlert = (a) => {
    const whName = warehouses.find(w => w.id === a.warehouseId)?.name || ''
    const isOut = a.currentQty <= 0
    return (
      <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: isOut ? '#FEE2E2' : '#FFF7ED',
        border: `1px solid ${isOut ? '#FCA5A5' : '#FCD34D'}`,
        borderRadius: 10, padding: '8px 10px', marginBottom: 5 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: isOut ? '#DC2626' : '#92600A',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {isOut ? '🔴' : '🟡'} {a.itemName}
            {whName && <span style={{ fontSize: 10, fontWeight: 500, color: '#6B7280', marginLeft: 4 }}>({whName})</span>}
          </div>
          <div style={{ fontSize: 10, color: '#6B7280', marginTop: 1 }}>
            เหลือ <strong>{a.currentQty}</strong> {a.unit} · ขั้นต่ำ {a.minQty} {a.unit}
          </div>
        </div>
        <span style={{ background: isOut ? '#DC2626' : '#D97706', color: '#fff',
          borderRadius: 6, padding: '2px 7px', fontSize: 9, fontWeight: 700,
          flexShrink: 0, marginLeft: 6 }}>
          {isOut ? 'หมด' : 'ใกล้หมด'}
        </span>
      </div>
    )
  }

  return (
    <div className="notif-bell-wrap" ref={ref}>
      <button className="notif-bell-btn" aria-label="แจ้งเตือน" onClick={() => setOpen(o => !o)}>
        🔔
        {count > 0 && <span className="notif-bell-badge">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="notif-panel" style={{ width: 340 }}>
          <div className="notif-panel-head">
            <span>🔔 แจ้งเตือนสต็อก ({count})</span>
          </div>
          <div className="notif-panel-list" style={{ maxHeight: '60vh', overflowY: 'auto', padding: 10 }}>
            {count === 0 ? (
              <div style={{ padding: '20px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 12 }}>
                ✅ ไม่มีการแจ้งเตือน
              </div>
            ) : (
              <>
                {mainAlerts.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#1F2937',
                      marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      🏬 คลังกลาง
                      <span style={{ background: '#FEE2E2', color: '#DC2626',
                        borderRadius: 99, padding: '0 7px', fontSize: 10 }}>
                        {mainAlerts.length}
                      </span>
                    </div>
                    {mainAlerts.map(renderAlert)}
                  </div>
                )}
                {branchAlerts.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#1F2937',
                      marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      🏪 สาขา
                      <span style={{ background: '#FEE2E2', color: '#DC2626',
                        borderRadius: 99, padding: '0 7px', fontSize: 10 }}>
                        {branchAlerts.length}
                      </span>
                    </div>
                    {branchAlerts.map(renderAlert)}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
