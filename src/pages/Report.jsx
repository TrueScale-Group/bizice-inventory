import { useState, useEffect, useRef } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, orderBy, doc, getDocs,
         updateDoc, addDoc, serverTimestamp, getDoc, writeBatch, increment, documentId } from 'firebase/firestore'
import { useSession } from '../hooks/useSession'
import { toDateKey, toThaiDate, toThaiShort, toThaiTime } from '../utils/formatDate'
import { COL } from '../constants/collections'
import { parseConvFactor, balanceId } from '../utils/unit'

/* ── helpers ──────────────────────────────────────────────────────────── */
function calcWasteCostFromCM(wasteLog, items, cmCosts) {
  if ((wasteLog.totalCost || 0) > 0) return wasteLog.totalCost
  const item = items.find(i => i.id === wasteLog.itemId)
  if (!item) return 0
  const cm = cmCosts[item.name]
  if (!cm) return 0
  const q = wasteLog.qty || 0
  const cpu = cm.costPerUse || 0
  const u = wasteLog.unit || ''
  if (u === item.unitSub && item.convUseToSub) return q * cpu / item.convUseToSub
  if (u === item.unitBuy && item.convBuyToUse) return q * cpu * item.convBuyToUse
  return q * cpu
}

function thb(n) {
  return `฿${(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function tsToDateKey(ts) {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* ── Sub-tab config ───────────────────────────────────────────────────── */
const SUB_TABS = [
  { id: 'daily',   icon: '📋', label: 'Daily log' },
  { id: 'waste',   icon: '🗑️', label: 'Waste' },
  { id: 'analyze', icon: '📊', label: 'Analyze' },
]

/* ── shared micro-components ──────────────────────────────────────────── */
function EmptyState({ msg = 'ไม่มีข้อมูล' }) {
  return (
    <div style={{ textAlign: 'center', padding: '18px 14px', color: '#C7C7CC', fontSize: 13 }}>{msg}</div>
  )
}

function CancelBtn({ onClick }) {
  return (
    <button onClick={onClick}
      style={{ border: 'none', background: '#FEF2F2', color: '#DC2626', borderRadius: 8,
        padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
        whiteSpace: 'nowrap', flexShrink: 0 }}>
      ยกเลิก
    </button>
  )
}

function CancelledBadge({ reason }) {
  return (
    <span style={{ fontSize: 10, color: '#DC2626', background: '#FEE2E2',
      borderRadius: 5, padding: '1px 6px', fontWeight: 700, whiteSpace: 'nowrap' }}>
      ยกเลิกแล้ว{reason ? ` · ${reason}` : ''}
    </span>
  )
}

/* ── Section header ───────────────────────────────────────────────────── */
function SectionHeader({ icon, label, count, badge }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14, flex: 1 }}>{label}</span>
      {count != null && (
        <span style={{ background: '#F2F2F7', borderRadius: 10, padding: '2px 8px',
          fontSize: 11, fontWeight: 700, color: '#8E8E93' }}>
          {count} รายการ
        </span>
      )}
      {badge}
    </div>
  )
}

/* ── CutLogCard — expandable with per-item cost ───────────────────────── */
function calcItemCost(it, items, cmCosts) {
  const q = it.qtyUse ?? it.qty ?? 0
  if (q === 0) return 0
  // lookup โดยตรงจาก itemName ก่อน (เร็วกว่า)
  const cm = cmCosts[it.itemName]
    || cmCosts[items.find(i => i.id === it.itemId)?.name]
  if (!cm) return 0
  return q * (cm.costPerUse || 0)
}

function CutLogCard({ log, items, cmCosts, onCancel, onCancelItem, onRestoreItem }) {
  const [open, setOpen] = useState(false)

  // คำนวณต้นทุนรายชิ้น
  const itemsWithCost = (log.items || []).map(it => {
    const invItem = items.find(i => i.id === it.itemId || i.name === it.itemName)
    return {
      ...it,
      qty:  it.qtyUse  ?? it.qty  ?? 0,
      unit: it.unitUse ?? it.unit ?? '',
      cost: it.costTotal > 0 ? it.costTotal : calcItemCost(it, items, cmCosts),
      displayLabel: invItem?.displayName || it.itemName,
    }
  })
  const totalCost = log.totalCost > 0
    ? log.totalCost
    : itemsWithCost.reduce((s, it) => s + it.cost, 0)

  return (
    <div style={{ background: '#fff', borderRadius: 10, marginBottom: 4, overflow: 'hidden',
      border: '1px solid #F3F4F6' }}>

      {/* Header row — single line compact */}
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center',
        gap: 8, padding: '7px 12px', cursor: 'pointer' }}>
        <span style={{ fontSize: 14, flexShrink: 0 }}>✂️</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#1C1C1E', flexShrink: 0 }}>
          {log.timestamp ? toThaiTime(log.timestamp) : ''}
        </span>
        <span style={{ fontSize: 11, color: '#8E8E93', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          · {log.staffName} · {log.items?.length || 0} รายการ
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#2563EB',
          background: '#EFF6FF', borderRadius: 6, padding: '1px 7px', flexShrink: 0 }}>
          {thb(totalCost)}
        </span>
        <span style={{ fontSize: 10, color: '#C7C7CC', transition: 'transform .2s',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)', display: 'inline-block', flexShrink: 0 }}>▾</span>
      </div>

      {/* Expanded: รายการ compact */}
      {open && (
        <div style={{ padding: '4px 14px 10px 14px', borderTop: '1px solid #F0F4FF', background: '#FAFBFF' }}>
          {itemsWithCost.map((it, i) => {
            const isCancelled = it.cancelled
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4,
                padding: '4px 0', borderBottom: i < itemsWithCost.length - 1 ? '1px solid #F0F0F0' : 'none',
                opacity: isCancelled ? 0.45 : 1,
                textDecoration: isCancelled ? 'line-through' : 'none' }}>
                {/* ชื่อ — ชิดซ้าย */}
                <span style={{ fontSize: 11, color: '#374151', flex: 2, minWidth: 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {isCancelled && <span style={{ color: '#DC2626', fontWeight: 700 }}>❌ </span>}
                  {it.displayLabel}
                </span>
                <span style={{ fontSize: 10, color: '#D1D5DB', flexShrink: 0 }}>--</span>
                <span style={{ fontSize: 11, color: '#9CA3AF', flex: 1, textAlign: 'center', flexShrink: 0 }}>
                  −{it.qty} {it.unit}
                </span>
                <span style={{ fontSize: 10, color: '#D1D5DB', flexShrink: 0 }}>--</span>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0, minWidth: 72 }}>
                  <span style={{ fontSize: 11, fontWeight: 700,
                    color: it.cost > 0 ? '#2563EB' : '#D1D5DB' }}>
                    {it.cost > 0 ? thb(it.cost) : '—'}
                  </span>
                  {it.cost > 0 && it.qty > 0 && (
                    <span style={{ fontSize: 9, color: '#9CA3AF', marginTop: 1 }}>
                      ({it.qty} × ฿{(it.cost / it.qty).toFixed(2)})
                    </span>
                  )}
                </span>
                {/* per-item cancel */}
                {!isCancelled && onCancelItem && (
                  <button onClick={e => { e.stopPropagation(); onCancelItem(log, i, it) }}
                    title="ยกเลิกรายการนี้ + คืน stock"
                    style={{ width: 22, height: 22, borderRadius: 5, border: 'none',
                      background: '#FEE2E2', color: '#DC2626', cursor: 'pointer',
                      fontSize: 10, fontWeight: 700, marginLeft: 4, flexShrink: 0 }}>
                    ✕
                  </button>
                )}
                {isCancelled && it.cancelReason && (
                  <span style={{ fontSize: 9, color: '#DC2626', marginLeft: 4 }} title={it.cancelReason}>
                    💬
                  </span>
                )}
              </div>
            )
          })}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={e => { e.stopPropagation(); onCancel(log) }}
              style={{ border: 'none', background: '#FEF2F2', color: '#DC2626', borderRadius: 8,
                padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── CancelSheet (generic) ────────────────────────────────────────────── */
function CancelSheet({ entry, label, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  if (!entry) return null
  async function confirm() {
    if (reason.trim().length < 3) return
    setLoading(true)
    await onConfirm(entry, reason.trim())
    setLoading(false)
    onClose()
  }
  function blockEvent(e) { e.stopPropagation(); e.preventDefault() }
  return (
    <div className="modal-backdrop"
      onClick={blockEvent} onTouchStart={blockEvent} onTouchEnd={blockEvent} onPointerDown={blockEvent}>
      <div className="bottom-sheet"
        onClick={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}>

        <div className="sheet-handle" />
        <div className="sheet-header">
          <span className="sheet-title">ยกเลิก{label}</span>
          <button className="sheet-close" onClick={onClose}>✕</button>
        </div>
        <div className="sheet-body">
          <div style={{ background: '#FDF2F8', borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 12 }}>
            <div style={{ fontWeight: 700, color: '#DC2626', marginBottom: 4 }}>⚠️ รายการที่จะยกเลิก</div>
            <div style={{ color: '#374151', fontSize: 13 }}>{entry._desc || '-'}</div>
            <div style={{ color: '#9CA3AF', marginTop: 4, fontSize: 11 }}>บันทึกโดย {entry._staff || entry.staffName || '-'}</div>
          </div>
          <label className="fi-label">เหตุผล (อย่างน้อย 3 ตัวอักษร)</label>
          <textarea className="fi" rows={3} placeholder="ระบุเหตุผล..." value={reason}
            onChange={e => setReason(e.target.value)} style={{ resize: 'none' }} />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={onClose}>ปิด</button>
            <button style={{ flex: 2, background: '#DC2626', color: '#fff', border: 'none',
              borderRadius: 14, padding: '12px 0', fontSize: 15, fontWeight: 700, cursor: 'pointer',
              opacity: reason.trim().length < 3 || loading ? 0.5 : 1 }}
              onClick={confirm} disabled={reason.trim().length < 3 || loading}>
              {loading ? 'กำลังบันทึก...' : '✓ ยืนยันยกเลิก'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── LogRow (accordion) ───────────────────────────────────────────────── */
const ACTION_MAP = {
  receive:           { icon: '📥', label: 'รับสินค้า',      color: '#16A34A', bg: '#DCFCE7' },
  cancel:            { icon: '↩️', label: 'ยกเลิก',         color: '#DC2626', bg: '#FEE2E2' },
  cancel_waste:      { icon: '↩️', label: 'ยกเลิกของเสีย',  color: '#DC2626', bg: '#FEE2E2' },
  delete_log:        { icon: '🗑️', label: 'ลบ Log',         color: '#DC2626', bg: '#FEE2E2' },
  cut_stock:         { icon: '✂️', label: 'ตัดสต็อก',       color: '#DB2777', bg: '#FDF2F8' },
  waste:             { icon: '🗑️', label: 'ของเสีย',        color: '#D97706', bg: '#FFF7ED' },
  transfer:          { icon: '🚚', label: 'โอนสินค้า',      color: '#0369A1', bg: '#E0F2FE' },
  transfer_dispatch: { icon: '🚚', label: 'นำส่งสินค้า',    color: '#0369A1', bg: '#E0F2FE' },
  transfer_received: { icon: '📦', label: 'รับสินค้าจากโอน', color: '#16A34A', bg: '#DCFCE7' },
  refill_request:    { icon: '🧾', label: 'แจ้งเติมของ',    color: '#D97706', bg: '#FFF7ED' },
  update:            { icon: '✏️', label: 'แก้ไข',          color: '#7C3AED', bg: '#EDE9FE' },
  default:           { icon: '📝', label: 'บันทึก',          color: '#6B7280', bg: '#F3F4F6' },
}

function LogRow({ l }) {
  const [open, setOpen] = useState(false)
  const meta = ACTION_MAP[l.action] || ACTION_MAP.default
  return (
    <div style={{ borderTop: '1px solid #F3F4F6' }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
          cursor: 'pointer', background: open ? '#F9FAFB' : 'transparent', transition: 'background .15s' }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: meta.bg,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>
          {meta.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: meta.color,
              background: meta.bg, borderRadius: 5, padding: '1px 6px' }}>{meta.label}</span>
            {l.cancelled && (
              <span style={{ fontSize: 9, background: '#FEE2E2', color: '#DC2626',
                borderRadius: 4, padding: '1px 5px', fontWeight: 700 }}>ยกเลิกแล้ว</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            textDecoration: l.cancelled ? 'line-through' : 'none' }}>
            {l.staffName} · {l.detail}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
          <span style={{ fontSize: 10, color: '#C7C7CC' }}>{l.timestamp ? toThaiTime(l.timestamp) : ''}</span>
          <span style={{ fontSize: 12, color: '#9CA3AF', transition: 'transform .2s',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
        </div>
      </div>
      {open && (
        <div style={{ background: '#F9FAFB', padding: '10px 14px 12px 54px',
          borderTop: '1px solid #F3F4F6', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#9CA3AF', fontWeight: 700 }}>บันทึกโดย: </span>
            <span style={{ color: '#374151' }}>{l.staffName || '-'}</span>
          </div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#9CA3AF', fontWeight: 700 }}>Action: </span>
            <span style={{ color: '#374151' }}>{l.action}</span>
          </div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#9CA3AF', fontWeight: 700 }}>รายละเอียด: </span>
            <span style={{ color: '#374151' }}>{l.detail || '-'}</span>
          </div>
          {l.warehouseId && (
            <div style={{ fontSize: 11 }}>
              <span style={{ color: '#9CA3AF', fontWeight: 700 }}>คลัง: </span>
              <span style={{ color: '#374151' }}>{l.warehouseId}</span>
            </div>
          )}
          {l.cancelled && (
            <>
              <div style={{ fontSize: 11, color: '#DC2626', fontWeight: 700, marginTop: 4 }}>
                ↩️ ยกเลิกโดย: {l.cancelledBy || '-'}
              </div>
              <div style={{ fontSize: 11, color: '#DC2626' }}>เหตุผล: {l.cancelReason || '-'}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ── TransferDetailModal — popup รายละเอียดใบโอน ──────────────────────── */
function TransferDetailModal({ tf, onClose, items = [], catOrder = [] }) {
  const [xBounce, setXBounce] = useState(false)
  function bounceX(e) {
    if (e) { e.stopPropagation(); e.preventDefault() }
    setXBounce(false)
    requestAnimationFrame(() => requestAnimationFrame(() => setXBounce(true)))
  }
  if (!tf) return null
  // Master lookup → enrich tf items with category + sortOrder + img
  const itemMap = {}
  items.forEach(it => { itemMap[it.id] = it })
  const enriched = (tf.items || []).map(it => {
    const m = itemMap[it.itemId] || {}
    return {
      ...it,
      _cat:  m.category || 'อื่นๆ',
      _sort: typeof m.sortOrder === 'number' ? m.sortOrder : 9999,
      _img:  m.img || '📦',
      _displayName: m.displayName || it.itemName,
    }
  })
  // Group by category
  const groups = {}
  enriched.forEach(it => { (groups[it._cat] = groups[it._cat] || []).push(it) })
  Object.values(groups).forEach(arr => arr.sort((a, b) => a._sort - b._sort))
  // Order categories by catOrder (from Inv_settings/categories), unknowns → end
  const orderIdx = {}
  catOrder.forEach((name, i) => { orderIdx[name] = i })
  const cats = Object.keys(groups).sort((a, b) => {
    const ia = orderIdx[a] != null ? orderIdx[a] : 9999
    const ib = orderIdx[b] != null ? orderIdx[b] : 9999
    if (ia !== ib) return ia - ib
    return a.localeCompare(b, 'th')
  })
  const stMap = {
    received:  { label: '✅ รับแล้ว',  color: '#16A34A', bg: '#DCFCE7' },
    cancelled: { label: '❌ ยกเลิก',    color: '#DC2626', bg: '#FEE2E2' },
    in_transit:{ label: '🟡 รอรับ',     color: '#92400E', bg: '#FEF9C3' },
  }
  const st = stMap[tf.status] || stMap.in_transit
  return (
    <div onClick={bounceX} onTouchStart={bounceX} onPointerDown={bounceX}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px 16px calc(86px + env(safe-area-inset-bottom)) 16px' }}>
      <div onClick={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 22, width: '100%', maxWidth: 460,
          maxHeight: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column',
          border: '1.5px solid rgba(227,30,36,.35)',
          boxShadow: '0 12px 40px rgba(0,0,0,.22), 0 0 0 4px rgba(227,30,36,.06)' }}>
        {/* sticky header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8,
          padding: '14px 16px', borderBottom: '1px solid #F3F4F6',
          background: '#fff', position: 'sticky', top: 0, zIndex: 2, flexShrink: 0 }}>
          <span style={{ fontSize: 18 }}>🚚</span>
          <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 15, flex: 1 }}>
            ใบโอน #{tf.id?.slice(-6) || tf.id}
          </span>
          <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 6, padding: '2px 8px',
            background: st.bg, color: st.color }}>{st.label}</span>
          <button onClick={onClose} aria-label="ปิด" className="popup-x-btn"
            onAnimationEnd={() => setXBounce(false)}
            style={{ marginLeft: 4, animation: xBounce ? 'xBounce 0.45s ease' : 'none' }}>✕</button>
        </div>
        {/* scrollable body */}
        <div style={{ padding: 16, overflow: 'auto', flex: 1 }}>

        {/* From → To */}
        <div style={{ background: '#F9FAFB', borderRadius: 12, padding: '10px 12px',
          marginBottom: 10, fontSize: 12, color: '#374151', fontWeight: 600 }}>
          {tf.fromWarehouseName || 'คลังกลาง'} <span style={{ color: '#9CA3AF' }}>→</span> {tf.toWarehouseName || 'ร้าน'}
        </div>

        {/* timeline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 14 }}>📤</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#9CA3AF' }}>นำส่งโดย</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{tf.createdBy || '-'}</div>
              {tf.createdAt && (
                <div style={{ fontSize: 11, color: '#6B7280' }}>
                  🕐 {toThaiDate(tf.createdAt?.toDate ? tf.createdAt.toDate() : tf.createdAt)} {toThaiTime(tf.createdAt)}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 14 }}>📥</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#9CA3AF' }}>ผู้รับ</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {tf.receivedBy || (tf.status === 'received' ? '-' : '— ยังไม่ได้รับ')}
              </div>
              {tf.receivedAt && (
                <div style={{ fontSize: 11, color: '#6B7280' }}>
                  🕐 {toThaiDate(tf.receivedAt?.toDate ? tf.receivedAt.toDate() : tf.receivedAt)} {toThaiTime(tf.receivedAt)}
                </div>
              )}
            </div>
          </div>
          {tf.status === 'cancelled' && (
            <div style={{ background: '#FEF2F2', borderRadius: 10, padding: '8px 10px',
              fontSize: 11, color: '#991B1B' }}>
              ❌ ยกเลิกโดย <b>{tf.cancelledBy || '-'}</b>
              {tf.cancelReason && <div style={{ marginTop: 2 }}>เหตุผล: {tf.cancelReason}</div>}
            </div>
          )}
        </div>

        {/* items list — grouped by category */}
        <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
          📋 รายการ ({tf.items?.length || 0})
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {cats.map(catName => (
            <div key={catName} style={{ background: '#FAFBFF', borderRadius: 12,
              border: '1px solid #F0F4FF', overflow: 'hidden' }}>
              <div style={{ padding: '6px 12px', background: '#EFF2FF',
                fontSize: 11, fontWeight: 700, color: '#4338CA',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>🏷️ {catName}</span>
                <span style={{ background: '#fff', borderRadius: 8, padding: '1px 8px',
                  color: '#4338CA', fontSize: 10 }}>{groups[catName].length}</span>
              </div>
              <div style={{ padding: '4px 12px 8px' }}>
                {groups[catName].map((it, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between',
                    gap: 8, padding: '5px 0',
                    borderBottom: i < groups[catName].length - 1 ? '1px solid #EEF2FF' : 'none' }}>
                    <span style={{ fontSize: 12, color: '#374151', flex: 1, minWidth: 0,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {it._img} {it._displayName}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#1C1C1E', flexShrink: 0 }}>
                      {it.qty} {it.unit}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        </div>
      </div>
    </div>
  )
}

/* ── CutSummaryPopup — สรุปวัตถุดิบที่ใช้ในวันที่เลือก แยกตามหมวด ── */
function CutSummaryPopup({ cutLogs = [], items = [], catOrder = [], onClose }) {
  const [xBounce, setXBounce] = useState(false)
  function bounceX(e) {
    if (e) { e.stopPropagation(); e.preventDefault() }
    setXBounce(false)
    requestAnimationFrame(() => requestAnimationFrame(() => setXBounce(true)))
  }
  // Aggregate ทุก cut log → group by item (รวม qty)
  const itemMap = {}      // itemId → { name, qty, unit, cat, sort, img }
  items.forEach(i => { /* lookup table */ })
  const itemLookup = {}
  items.forEach(i => { itemLookup[i.id] = i })
  cutLogs.forEach(l => {
    (l.items || []).forEach(it => {
      if (it.cancelled) return
      const master = itemLookup[it.itemId] || {}
      const key = it.itemId || it.itemName
      if (!itemMap[key]) itemMap[key] = {
        name: master.displayName || it.itemName,
        qty: 0,
        unit: master.unitUse || it.unitUse || it.unit || '',
        cat:  master.category || 'อื่นๆ',
        sort: typeof master.sortOrder === 'number' ? master.sortOrder : 9999,
        img:  master.img || '📦',
      }
      itemMap[key].qty += Number(it.qtyUse || it.qty || 0)
    })
  })
  const list = Object.values(itemMap)

  // Group by cat → sort by catOrder + sortOrder
  const orderIdx = {}
  catOrder.forEach((n, i) => { orderIdx[n] = i })
  const groups = {}
  list.forEach(it => { (groups[it.cat] = groups[it.cat] || []).push(it) })
  Object.values(groups).forEach(arr => arr.sort((a, b) => a.sort - b.sort))
  const cats = Object.keys(groups).sort((a, b) => {
    const ia = orderIdx[a] != null ? orderIdx[a] : 9999
    const ib = orderIdx[b] != null ? orderIdx[b] : 9999
    return ia - ib || a.localeCompare(b, 'th')
  })

  const totalCutCount = cutLogs.length
  const totalItems = list.length

  // Cat emoji fallback
  const CAT_EMOJI = { 'แยม':'🍓','ผลไม้':'🍋','ไซรัป':'🍯','ท็อปปิ้ง':'💎',
    'วัตถุดิบ':'🥛','บรรจุภัณฑ์':'🥤','อื่นๆ':'🔖' }

  return (
    <div onClick={bounceX} onTouchStart={bounceX} onPointerDown={bounceX}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px 16px calc(86px + env(safe-area-inset-bottom)) 16px' }}>
      <div onClick={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 22, width: '100%', maxWidth: 500,
          maxHeight: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column',
          border: '1.5px solid rgba(219,39,119,.35)',
          boxShadow: '0 12px 40px rgba(0,0,0,.22), 0 0 0 4px rgba(219,39,119,.06)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8,
          padding: '14px 16px', borderBottom: '1px solid #F3F4F6',
          background: '#fff', position: 'sticky', top: 0, zIndex: 2 }}>
          <span style={{ fontSize: 20 }}>✂️</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14 }}>
              สรุปวัตถุดิบที่ใช้
            </div>
            <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 1 }}>
              {totalCutCount} ใบตัด · {totalItems} วัตถุดิบ
            </div>
          </div>
          <button onClick={onClose} aria-label="ปิด" className="popup-x-btn"
            onAnimationEnd={() => setXBounce(false)}
            style={{ animation: xBounce ? 'xBounce 0.45s ease' : 'none' }}>✕</button>
        </div>
        {/* Body */}
        <div style={{ overflow: 'auto', flex: 1, padding: 12 }}>
          {cats.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 12 }}>
              ไม่มีข้อมูล
            </div>
          ) : cats.map(catName => (
            <div key={catName} style={{ background: '#FAFBFF', borderRadius: 12,
              border: '1px solid #F0F4FF', overflow: 'hidden', marginBottom: 10 }}>
              <div style={{ padding: '8px 12px', background: '#EFF2FF',
                fontSize: 12, fontWeight: 700, color: '#4338CA',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{CAT_EMOJI[catName] || '🏷️'} {catName}</span>
                <span style={{ background: '#fff', borderRadius: 8, padding: '1px 8px',
                  color: '#4338CA', fontSize: 10 }}>{groups[catName].length} รายการ</span>
              </div>
              <div style={{ padding: '4px 12px 8px' }}>
                {groups[catName].map((it, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between',
                    gap: 8, padding: '6px 0',
                    borderBottom: i < groups[catName].length - 1 ? '1px solid #EEF2FF' : 'none' }}>
                    <span style={{ fontSize: 12.5, color: '#374151', flex: 1, minWidth: 0,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {it.img} {it.name}
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#DB2777', flexShrink: 0 }}>
                      {it.qty.toLocaleString('th-TH', { maximumFractionDigits: 2 })} {it.unit}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ── EventDetailPopup — universal popup สำหรับ waste / receive / refill ── */
function EventDetailPopup({ detail, items = [], catOrder = [], onClose }) {
  const [xBounce, setXBounce] = useState(false)
  function bounceX(e) {
    if (e) { e.stopPropagation(); e.preventDefault() }
    setXBounce(false)
    requestAnimationFrame(() => requestAnimationFrame(() => setXBounce(true)))
  }
  if (!detail) return null
  const { type, data } = detail

  const meta = type === 'waste'   ? { icon: '🌙', title: 'ของเสียปิดร้าน', accent: '#6366F1', bg: 'rgba(99,102,241,.06)', ring: 'rgba(99,102,241,.35)' }
             : type === 'receive' ? { icon: '📥', title: 'รับสินค้า',      accent: '#16A34A', bg: 'rgba(22,163,74,.06)',  ring: 'rgba(22,163,74,.35)' }
             :                      { icon: '🧾', title: 'แจ้งเติมของ',    accent: '#D97706', bg: 'rgba(217,119,6,.06)',  ring: 'rgba(217,119,6,.35)' }

  function fmtDT(ts) {
    if (!ts) return '-'
    const d = ts.toDate ? ts.toDate() : (ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts))
    return `${toThaiDate(d)} ${d.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})} น.`
  }

  return (
    <div onClick={bounceX} onTouchStart={bounceX} onPointerDown={bounceX}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px 16px calc(86px + env(safe-area-inset-bottom)) 16px' }}>
      <div onClick={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 22, width: '100%', maxWidth: 500,
          maxHeight: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column',
          border: `1.5px solid ${meta.ring}`,
          boxShadow: `0 12px 40px rgba(0,0,0,.22), 0 0 0 4px ${meta.bg}` }}>
        {/* Sticky header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8,
          padding: '14px 16px', borderBottom: '1px solid #F3F4F6',
          background: '#fff', position: 'sticky', top: 0, zIndex: 2 }}>
          <span style={{ fontSize: 20 }}>{meta.icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 15 }}>{meta.title}</div>
            <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 1 }}>
              {type === 'refill'  && (data.rfRef || data.id?.slice(-8))}
              {type === 'waste'   && (data.itemName || '-')}
              {type === 'receive' && (data.detail || '-')}
            </div>
          </div>
          <button onClick={onClose} aria-label="ปิด" className="popup-x-btn"
            onAnimationEnd={() => setXBounce(false)}
            style={{ animation: xBounce ? 'xBounce 0.45s ease' : 'none' }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: 16, overflow: 'auto', flex: 1 }}>
          {/* ── Waste ── */}
          {type === 'waste' && (() => {
            const w = data
            return (
              <>
                <DetailRow label="🏪 คลัง"  value={w.warehouseName || w.warehouseId || '-'} />
                <DetailRow label="👤 บันทึกโดย" value={w.staffName || '-'} />
                <DetailRow label="🕐 วันเวลา" value={fmtDT(w.timestamp)} />
                <DetailRow label="📦 รายการ" value={`${w.img || ''} ${w.itemName || '-'}`} />
                <DetailRow label="⚖️ จำนวน" value={`${w.qty} ${w.unit}`} />
                {w._cost > 0 && (
                  <DetailRow label="💵 มูลค่า" value={thb(w._cost)}
                    valColor="#DC2626" valBg="#FEE2E2" />
                )}
                {w.note && <DetailRow label="📝 หมายเหตุ" value={w.note} multiline />}
                {w.type && <DetailRow label="🏷️ ประเภท" value={w.type === 'closing' ? 'ปิดร้าน' : 'ระหว่างวัน'} />}
              </>
            )
          })()}

          {/* ── Receive ── */}
          {type === 'receive' && (() => {
            const r = data
            return (
              <>
                <DetailRow label="🕐 วันเวลา" value={fmtDT(r.timestamp)} />
                <DetailRow label="👤 ผู้รับ"  value={r.staffName || '-'} />
                {r.warehouseId && (
                  <DetailRow label="🏪 คลัง" value={r.warehouseId} />
                )}
                <DetailRow label="📝 รายละเอียด" value={r.detail || r.itemName || '-'} multiline />
                {r.note && <DetailRow label="📌 หมายเหตุ" value={r.note} multiline />}
              </>
            )
          })()}

          {/* ── Refill ── */}
          {type === 'refill' && (() => {
            const rf = data
            const stMap = {
              pending:    { label: '🟡 รอดำเนินการ',     color: '#D97706', bg: '#FEF3C7' },
              processing: { label: '🔵 กำลังดำเนินการ',   color: '#1D4ED8', bg: '#DBEAFE' },
              done:       { label: '🟢 เสร็จแล้ว',        color: '#16A34A', bg: '#DCFCE7' },
              cancelled:  { label: '⚫ ยกเลิก',           color: '#6B7280', bg: '#F3F4F6' },
            }
            const st = stMap[rf.status] || { label: rf.status, color: '#6B7280', bg: '#F3F4F6' }
            // group items by category
            const itemMap = {}
            items.forEach(it => { itemMap[it.id] = it })
            const enriched = (rf.items || []).map(it => {
              const m = itemMap[it.itemId] || {}
              return { ...it,
                _cat: m.category || 'อื่นๆ',
                _sort: typeof m.sortOrder === 'number' ? m.sortOrder : 9999,
                _img: m.img || it.img || '📦',
                _name: m.displayName || it.itemName,
              }
            })
            const groups = {}
            enriched.forEach(it => { (groups[it._cat] = groups[it._cat] || []).push(it) })
            Object.values(groups).forEach(arr => arr.sort((a,b) => a._sort - b._sort))
            const orderIdx = {}
            catOrder.forEach((n,i) => { orderIdx[n] = i })
            const cats = Object.keys(groups).sort((a,b) => {
              const ia = orderIdx[a] != null ? orderIdx[a] : 9999
              const ib = orderIdx[b] != null ? orderIdx[b] : 9999
              return ia - ib || a.localeCompare(b, 'th')
            })
            return (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px',
                    background: st.bg, color: st.color, borderRadius: 8 }}>{st.label}</span>
                </div>
                <DetailRow label="🆔 เลขที่"   value={rf.rfRef || rf.id?.slice(-8)} />
                <DetailRow label="👤 แจ้งโดย"  value={rf.requestedBy || 'ไม่ระบุ'} />
                <DetailRow label="🕐 แจ้งเมื่อ" value={fmtDT(rf.requestedAt)} />
                {rf.completedAt && (
                  <DetailRow label="✅ ดำเนินการเสร็จ" value={fmtDT(rf.completedAt)} />
                )}
                {rf.tfRef && (
                  <DetailRow label="🚚 ใบโอน" value={rf.tfRef} valBg="#E0F2FE" valColor="#0369A1" />
                )}
                {rf.cancelReason && (
                  <DetailRow label="❌ เหตุผลยกเลิก" value={rf.cancelReason} multiline
                    valColor="#DC2626" />
                )}
                <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13,
                  marginTop: 14, marginBottom: 6 }}>
                  📋 รายการ ({rf.items?.length || 0})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {cats.map(catName => (
                    <div key={catName} style={{ background: '#FAFBFF', borderRadius: 12,
                      border: '1px solid #F0F4FF', overflow: 'hidden' }}>
                      <div style={{ padding: '6px 12px', background: '#EFF2FF',
                        fontSize: 11, fontWeight: 700, color: '#4338CA',
                        display: 'flex', justifyContent: 'space-between' }}>
                        <span>🏷️ {catName}</span>
                        <span style={{ background: '#fff', borderRadius: 8, padding: '1px 8px',
                          color: '#4338CA', fontSize: 10 }}>{groups[catName].length}</span>
                      </div>
                      <div style={{ padding: '4px 12px 8px' }}>
                        {groups[catName].map((it, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between',
                            gap: 8, padding: '5px 0',
                            borderBottom: i < groups[catName].length - 1 ? '1px solid #EEF2FF' : 'none' }}>
                            <span style={{ fontSize: 12, color: '#374151', flex: 1, minWidth: 0,
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {it._img} {it._name}
                            </span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: '#1C1C1E', flexShrink: 0 }}>
                              {it.qty > 0 ? `×${it.qty}` : '-'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

function DetailRow({ label, value, multiline, valColor, valBg }) {
  return (
    <div style={{ display: 'flex', alignItems: multiline ? 'flex-start' : 'center',
      padding: '7px 0', borderBottom: '1px solid #F3F4F6', gap: 8 }}>
      <span style={{ fontSize: 11, color: '#6B7280', minWidth: 100, fontWeight: 600 }}>
        {label}
      </span>
      <span style={{ fontSize: 12, color: valColor || '#1C1C1E', flex: 1, textAlign: 'right',
        fontWeight: 600, background: valBg || 'transparent',
        borderRadius: valBg ? 6 : 0, padding: valBg ? '2px 8px' : 0,
        wordBreak: multiline ? 'break-word' : 'normal' }}>
        {value}
      </span>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   DailyTab — 7 กลุ่มข้อมูล
   ══════════════════════════════════════════════════════════════════════ */
function DailyTab({ cutLogs, fruitWaste, closingWaste, receiveLogs, transfers, auditLogs,
                    items, catOrder = [], cmCosts, openCancel, cancelCutLog, cancelCutLogItem, restoreCutLogItem,
                    cancelWasteLog, cancelAuditEntry, cancelTransfer, dailyRFs }) {

  /* KPI values */
  const activeCut   = cutLogs.filter(l => !l.cancelled && !l.deletedAt)
  const activeWaste = [...fruitWaste, ...closingWaste].filter(l => !l.cancelled)
  const totalCutCost = activeCut.reduce((s, l) => {
    if (l.totalCost > 0) return s + l.totalCost
    const sum = (l.items || []).reduce((ss, it) => ss + calcItemCost(it, items, cmCosts), 0)
    return s + sum
  }, 0)
  const totalWasteCost = activeWaste.reduce((s, l) => s + calcWasteCostFromCM(l, items, cmCosts), 0)
  const pendingTf = transfers.filter(t => t.status === 'in_transit')
  const [tfDetail, setTfDetail] = useState(null)
  const [detail, setDetail] = useState(null)   // {type, data} สำหรับ Refill / Receive / Waste
  const [cutSumOpen, setCutSumOpen] = useState(false)   // popup สรุปตัดสต็อกของวันที่เลือก

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

      {/* ── KPI 2×2 ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
        <div style={{ background: '#fff', borderRadius: 14, padding: '12px 14px',
          border: '1px solid #F3F4F6', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 4 }}>💰 ต้นทุนวัตถุดิบ</div>
          <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 20, color: '#DB2777' }}>
            {thb(totalCutCost).replace('฿', 'B')}
          </div>
        </div>
        <div style={{ background: '#fff', borderRadius: 14, padding: '12px 14px',
          border: '1px solid #F3F4F6', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 4 }}>✂️ ครั้งตัดสต็อก</div>
          <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 20, color: '#1C1C1E' }}>
            {activeCut.length}
          </div>
        </div>
        <div style={{ background: '#fff', borderRadius: 14, padding: '12px 14px',
          border: '1px solid #F3F4F6', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 4 }}>🗑️ ของเสียวันนี้</div>
          <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 20, color: '#D97706' }}>
            {thb(totalWasteCost).replace('฿', 'B')}
          </div>
        </div>
        <div style={{ background: '#fff', borderRadius: 14, padding: '12px 14px',
          border: '1px solid #F3F4F6', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 4 }}>📦 ใบโอนสินค้า</div>
          <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 20, color: '#0369A1' }}>
            {pendingTf.length}
          </div>
        </div>
      </div>

      {/* ═══ Group 1: ✂️ ตัดสต็อก ═══ */}
      <DataSection icon="✂️" label="ตัดสต็อก" count={activeCut.length}
        headerExtra={activeCut.length > 0 && (
          <button onClick={() => setCutSumOpen(true)}
            title="สรุปวัตถุดิบที่ใช้ในวันที่เลือก"
            style={{ border: '1px solid #FCE7F3', background: '#FDF2F8', color: '#DB2777',
              borderRadius: 999, padding: '4px 10px', fontSize: 11, fontWeight: 700,
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            🔍 สรุป
          </button>
        )}>
        {activeCut.length === 0 && cutLogs.filter(l => l.cancelled || l.deletedAt).length === 0
          ? <EmptyState msg="ยังไม่มีการตัดสต็อก" />
          : [...activeCut].sort((a,b) => (b.timestamp?.seconds||0) - (a.timestamp?.seconds||0)).map(log => (
            <CutLogCard key={log.id} log={log} items={items} cmCosts={cmCosts}
              onCancel={log => openCancel({ ...log,
                _desc: `ตัดสต็อก ${log.items?.length || 0} รายการ`,
                _staff: log.staffName }, 'ตัดสต็อก', cancelCutLog)}
              onCancelItem={(parentLog, idx, item) => openCancel({
                ...parentLog,
                _itemIdx: idx,
                _desc: `${item.itemName || item.displayLabel} ${item.qty} ${item.unit} (ใบ #${parentLog.id?.slice(-6)})`,
                _staff: parentLog.staffName,
              }, 'รายการตัดสต็อก',
                async (entry, reason) => cancelCutLogItem(entry, entry._itemIdx, reason))}
              onRestoreItem={(parentLog, idx) => restoreCutLogItem(parentLog, idx)} />
          ))
        }
        {cutLogs.filter(l => l.cancelled || l.deletedAt).map(log => (
          <CancelledRow key={log.id}
            text={`${log.staffName} · ${log.items?.length || 0} รายการ · ${toThaiTime(log.timestamp)}`}
            reason={log.cancelReason || log.deleteReason} />
        ))}
      </DataSection>

      {/* ═══ Group 2: 🍋 ผลไม้เสียระหว่างวัน ═══ */}
      <DataSection icon="🍋" label="ผลไม้เสียระหว่างวัน" count={fruitWaste.filter(l => !l.cancelled).length}>
        {fruitWaste.length === 0
          ? <EmptyState />
          : fruitWaste.filter(l => !l.cancelled).map(w => {
            const cost = calcWasteCostFromCM(w, items, cmCosts)
            return (
              <ItemCard key={w.id}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{w.img || ''} {w.itemName}</div>
                  <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 2 }}>
                    {toThaiTime(w.timestamp)} · {w.staffName}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#FF9500' }}>{w.qty} {w.unit}</div>
                    {cost > 0 && <div style={{ fontSize: 11, color: '#92600A', background: '#FFF7ED',
                      borderRadius: 5, padding: '1px 6px', fontWeight: 700 }}>{thb(cost)}</div>}
                  </div>
                  <CancelBtn onClick={() => openCancel({ ...w,
                    _desc: `${w.itemName} ${w.qty} ${w.unit}${cost > 0 ? ` (${thb(cost)})` : ''}`,
                    _staff: w.staffName }, 'ผลไม้เสีย', cancelWasteLog)} />
                </div>
              </ItemCard>
            )
          })
        }
        {fruitWaste.filter(l => l.cancelled).map(w => (
          <CancelledRow key={w.id}
            text={`${w.img || ''} ${w.itemName} · ${w.qty} ${w.unit}`}
            reason={w.cancelReason} />
        ))}
      </DataSection>

      {/* ═══ Group 3: 🌙 ของเสียปิดร้าน ═══ */}
      <DataSection icon="🌙" label="ของเสียปิดร้าน" count={closingWaste.filter(l => !l.cancelled).length}>
        {closingWaste.length === 0
          ? <EmptyState />
          : closingWaste.filter(l => !l.cancelled).map(w => {
            const cost = calcWasteCostFromCM(w, items, cmCosts)
            return (
              <div key={w.id} onClick={() => setDetail({ type: 'waste', data: { ...w, _cost: cost } })}
                style={{ background: '#fff', borderRadius: 12, border: '1px solid #F3F4F6',
                  padding: '11px 14px', marginBottom: 8, cursor: 'pointer',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{w.img || ''} {w.itemName}</div>
                  <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 2 }}>
                    {toThaiTime(w.timestamp)} · {w.staffName}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#6366F1' }}>{w.qty} {w.unit}</div>
                    {cost > 0 && <div style={{ fontSize: 11, color: '#4338CA', background: '#EEF2FF',
                      borderRadius: 5, padding: '1px 6px', fontWeight: 700 }}>{thb(cost)}</div>}
                  </div>
                  <CancelBtn onClick={() => openCancel({ ...w,
                    _desc: `${w.itemName} ${w.qty} ${w.unit}${cost > 0 ? ` (${thb(cost)})` : ''}`,
                    _staff: w.staffName }, 'ของเสียปิดร้าน', cancelWasteLog)} />
                </div>
              </div>
            )
          })
        }
        {closingWaste.filter(l => l.cancelled).map(w => (
          <CancelledRow key={w.id}
            text={`${w.img || ''} ${w.itemName} · ${w.qty} ${w.unit}`}
            reason={w.cancelReason} />
        ))}
      </DataSection>

      {/* ═══ Group 4: 📥 รับสินค้า ═══ */}
      <DataSection icon="📥" label="รับสินค้า" count={receiveLogs.filter(l => !l.cancelled).length}>
        {receiveLogs.length === 0
          ? <EmptyState msg="ไม่มีการรับสินค้าวันนี้" />
          : receiveLogs.filter(l => !l.cancelled).map(l => (
            <div key={l.id} onClick={() => setDetail({ type: 'receive', data: l })}
              style={{ background: '#fff', borderRadius: 12, border: '1px solid #F3F4F6',
                padding: '11px 14px', marginBottom: 8, cursor: 'pointer',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {l.detail?.replace('รับ ', '') || l.itemName || '-'}
                </div>
                <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 2 }}>
                  {toThaiTime(l.timestamp)} · {l.staffName}
                </div>
              </div>
              <div onClick={e => e.stopPropagation()}>
                <CancelBtn onClick={() => openCancel({ ...l,
                  _desc: l.detail || 'รับสินค้า',
                  _staff: l.staffName }, 'รับสินค้า', cancelAuditEntry)} />
              </div>
            </div>
          ))
        }
        {receiveLogs.filter(l => l.cancelled).map(l => (
          <CancelledRow key={l.id} text={l.detail} reason={l.cancelReason} />
        ))}
      </DataSection>

      {/* ═══ Group 5: 🚚 โอนสินค้า (เฉพาะวันที่เลือก) ═══ */}
      <DataSection icon="🚚" label="โอนสินค้า" count={transfers.filter(t => t.status !== 'cancelled').length}>
        {transfers.length === 0
          ? <EmptyState msg="ไม่มีใบโอนวันนี้" />
          : transfers.map(tf => (
            <div key={tf.id}
              onClick={() => setTfDetail(tf)}
              style={{ background: '#fff', borderRadius: 12,
              border: '1px solid #F3F4F6', padding: '11px 14px', marginBottom: 6,
              cursor: 'pointer',
              opacity: tf.cancelled || tf.status === 'cancelled' ? 0.55 : 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13 }}>
                  #{tf.id?.slice(-6) || tf.id}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
                  <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 6, padding: '2px 8px',
                    background: tf.status === 'received' ? '#DCFCE7' : tf.status === 'cancelled' ? '#FEE2E2' : '#FEF9C3',
                    color: tf.status === 'received' ? '#16A34A' : tf.status === 'cancelled' ? '#DC2626' : '#92400E' }}>
                    {tf.status === 'received' ? '✅ รับแล้ว' : tf.status === 'cancelled' ? '❌ ยกเลิก' : '🟡 รอรับ'}
                  </span>
                  {!tf.cancelled && tf.status !== 'cancelled' && (
                    <CancelBtn onClick={() => openCancel({ ...tf,
                      _desc: `ใบโอน #${tf.id?.slice(-6)} ${tf.fromWarehouseName || ''} → ${tf.toWarehouseName || ''}`,
                      _staff: tf.createdBy || '' }, 'ใบโอนสินค้า', cancelTransfer)} />
                  )}
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>
                {tf.fromWarehouseName || 'คลังกลาง'} → {tf.toWarehouseName || 'ร้าน'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                <div style={{ fontSize: 10, color: '#6B7280' }}>
                  📤 นำส่ง: <b>{tf.createdBy || '-'}</b>
                  {tf.createdAt && <span style={{ color: '#9CA3AF' }}> · {toThaiTime(tf.createdAt)}</span>}
                </div>
                <div style={{ fontSize: 10, color: '#6B7280' }}>
                  📥 รับ: <b>{tf.receivedBy || (tf.status === 'received' ? '-' : '— ยังไม่ได้รับ')}</b>
                  {tf.receivedAt && <span style={{ color: '#9CA3AF' }}> · {toThaiTime(tf.receivedAt)}</span>}
                </div>
              </div>
            </div>
          ))
        }
      </DataSection>

      {/* Transfer Detail popup */}
      {tfDetail && (
        <TransferDetailModal tf={tfDetail} items={items} catOrder={catOrder} onClose={() => setTfDetail(null)} />
      )}

      {/* ═══ Group 6: 🧾 แจ้งเติมของ ═══ */}
      <DataSection icon="🧾" label="แจ้งเติมของ" count={dailyRFs.length}>
        {dailyRFs.length === 0
          ? <EmptyState msg="ไม่มีการแจ้งเติมของวันนี้" />
          : dailyRFs.map(rf => {
              const statusMap = {
                pending:    { label: '🟡 รอดำเนินการ', color: '#D97706' },
                processing: { label: '🔵 กำลังดำเนินการ', color: '#1D4ED8' },
                done:       { label: '🟢 เสร็จแล้ว', color: '#16A34A' },
                cancelled:  { label: '⚫ ยกเลิก', color: '#6B7280' },
              }
              const st = statusMap[rf.status] || { label: rf.status, color: '#6B7280' }
              const ts = rf.requestedAt?.seconds
                ? new Date(rf.requestedAt.seconds * 1000)
                : null
              const timeStr = ts
                ? `${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')} น.`
                : ''
              return (
                <div key={rf.id} onClick={() => setDetail({ type: 'refill', data: rf })}
                  style={{ background: '#fff', borderRadius: 12, border: '1px solid #F3F4F6',
                    padding: '11px 14px', marginBottom: 8, cursor: 'pointer',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    {/* Ref + เวลา */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>
                        {rf.rfRef || rf.id.slice(-8)}
                      </span>
                      {timeStr && (
                        <span style={{ fontSize: 10, color: '#9CA3AF' }}>🕐 {timeStr}</span>
                      )}
                      <span style={{ fontSize: 10, fontWeight: 700, color: st.color, marginLeft: 'auto' }}>
                        {st.label}
                      </span>
                    </div>
                    {/* แจ้งโดย */}
                    <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>
                      👤 {rf.requestedBy || 'ไม่ระบุ'} · {rf.items?.length || 0} รายการ
                    </div>
                    {/* รายการสั้นๆ */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {(rf.items || []).slice(0, 3).map((it, i) => (
                        <span key={i} style={{ fontSize: 10, background: '#F3F4F6',
                          borderRadius: 5, padding: '2px 6px', color: '#374151' }}>
                          {it.img} {it.itemName}{it.qty > 0 ? ` ×${it.qty}` : ''}
                        </span>
                      ))}
                      {(rf.items?.length || 0) > 3 && (
                        <span style={{ fontSize: 10, color: '#9CA3AF', padding: '2px 6px' }}>
                          +{rf.items.length - 3} รายการ
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
        }
      </DataSection>

      {/* Generic Detail popup (waste, receive, refill) */}
      {detail && (
        <EventDetailPopup detail={detail} items={items} catOrder={catOrder}
          onClose={() => setDetail(null)} />
      )}

      {/* Cut Stock Summary popup */}
      {cutSumOpen && (
        <CutSummaryPopup cutLogs={activeCut} items={items} catOrder={catOrder}
          onClose={() => setCutSumOpen(false)} />
      )}

      {/* ═══ Group 7: 📋 Log (เฉพาะวันที่เลือก) ═══ */}
      <DataSection icon="📋" label="Log" noCount collapsible hint="เฉพาะกิจกรรมวันที่เลือก · ลบไม่ได้">
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #F3F4F6', overflow: 'hidden' }}>
          {auditLogs.length === 0
            ? <EmptyState msg="ไม่มี log วันนี้" />
            : auditLogs.map(l => <LogRow key={l.id} l={l} />)
          }
        </div>
      </DataSection>

    </div>
  )
}

/* ── Layout helpers ───────────────────────────────────────────────────── */
function DataSection({ icon, label, count, noCount, hint, collapsible, headerExtra, children }) {
  const [open, setOpen] = useState(!collapsible)          // collapsible starts closed
  return (
    <div style={{ marginBottom: 24 }}>
      {/* Section header */}
      <div
        onClick={collapsible ? () => setOpen(o => !o) : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: open ? 10 : 0,
          paddingBottom: 8, borderBottom: '2px solid #F2F2F7',
          cursor: collapsible ? 'pointer' : 'default' }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 15, flex: 1 }}>{label}</span>
        {headerExtra && (
          <span onClick={e => e.stopPropagation()}>{headerExtra}</span>
        )}
        {!noCount && count != null && (
          <span style={{ background: count > 0 ? '#FDF2F8' : '#F2F2F7',
            color: count > 0 ? '#DC2626' : '#8E8E93',
            borderRadius: 10, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>
            {count}
          </span>
        )}
        {hint && <span style={{ fontSize: 10, color: '#C7C7CC' }}>{hint}</span>}
        {collapsible && (
          <span style={{ fontSize: 14, color: '#C7C7CC', transition: 'transform .2s',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0 }}>▾</span>
        )}
      </div>
      {(!collapsible || open) && children}
    </div>
  )
}

function ItemCard({ children }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #F3F4F6',
      padding: '11px 14px', marginBottom: 8, display: 'flex',
      justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      {children}
    </div>
  )
}

function EmojiBox({ children }) {
  return (
    <div style={{ width: 36, height: 36, borderRadius: 10, background: '#F2F2F7',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 18, flexShrink: 0 }}>
      {children}
    </div>
  )
}

function CancelledRow({ text, reason }) {
  return (
    <div style={{ background: '#FAFAFA', borderRadius: 10, border: '1px solid #F3F4F6',
      padding: '9px 12px', marginBottom: 6, opacity: 0.6,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <div style={{ fontSize: 12, color: '#6B7280', textDecoration: 'line-through', flex: 1 }}>{text}</div>
      <CancelledBadge reason={reason} />
    </div>
  )
}

/* ── date-range helpers ───────────────────────────────────────────────── */
function getRangeKeys(period, custom) {
  const today = new Date()
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  if (period === 'custom' && custom?.start && custom?.end) {
    return { start: custom.start, end: custom.end }
  }
  if (period === 'thisWeek') {
    const day = today.getDay() === 0 ? 6 : today.getDay() - 1 // Mon=0
    const mon = new Date(today); mon.setDate(today.getDate() - day)
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
    return { start: fmt(mon), end: fmt(sun) }
  }
  if (period === 'lastWeek') {
    const day = today.getDay() === 0 ? 6 : today.getDay() - 1
    const thisMon = new Date(today); thisMon.setDate(today.getDate() - day)
    const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7)
    const lastSun = new Date(lastMon); lastSun.setDate(lastMon.getDate() + 6)
    return { start: fmt(lastMon), end: fmt(lastSun) }
  }
  if (period === 'thisMonth') {
    const s = new Date(today.getFullYear(), today.getMonth(), 1)
    const e = new Date(today.getFullYear(), today.getMonth()+1, 0)
    return { start: fmt(s), end: fmt(e) }
  }
  if (period === '3months' || period === 'custom') {
    // fallback ถ้ายังไม่เลือก custom range
    const s = new Date(today.getFullYear(), today.getMonth()-2, 1)
    return { start: fmt(s), end: fmt(today) }
  }
  // default thisWeek
  return getRangeKeys('thisWeek')
}

function allDayKeysLengthOver(start, end, n) {
  const s = new Date(start), e = new Date(end)
  const days = Math.floor((e - s) / 86400000) + 1
  return days >= n
}

function getDayKeys(start, end) {
  const keys = []
  const cur = new Date(start)
  const endD = new Date(end)
  while (cur <= endD) {
    keys.push(`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`)
    cur.setDate(cur.getDate()+1)
  }
  return keys
}

const DAY_ABBR = ['จ','อ','พ','พฤ','ศ','ส','อา']
function dayAbbr(dateKey) {
  const d = new Date(dateKey)
  const dow = d.getDay() // 0=Sun
  const idx = dow === 0 ? 6 : dow - 1
  return DAY_ABBR[idx]
}

/* ── AnalyzeTab (รวม Weekly + Analyze) ───────────────────────────────── */
function AnalyzeTab() {
  const [period, setPeriod] = useState('thisWeek')
  const [custom, setCustom] = useState({ start: '', end: '' })
  const [hoverIdx, setHoverIdx] = useState(null)
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 })
  const [cutLogs, setCutLogs] = useState([])
  const [wasteLogs, setWasteLogs] = useState([])
  const [incomeRecords, setIncomeRecords] = useState([])
  const [analyzeItems, setAnalyzeItems] = useState([])  // master data → displayName lookup

  useEffect(() => {
    return onSnapshot(collection(db, COL.ITEMS),
      snap => setAnalyzeItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [])

  const PILLS = [
    { id: 'thisWeek',  label: 'สัปดาห์นี้' },
    { id: 'lastWeek',  label: 'สัปดาห์ก่อน' },
    { id: 'thisMonth', label: 'เดือนนี้' },
    { id: 'custom',    label: '📅 เลือกช่วงเวลา' },
  ]

  const { start, end } = getRangeKeys(period, custom)

  useEffect(() => {
    const q = query(collection(db, COL.CUT_STOCK_LOGS),
      where('date', '>=', start), where('date', '<=', end))
    return onSnapshot(q, snap => setCutLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [start, end])

  useEffect(() => {
    const q = query(collection(db, COL.WASTE_LOGS),
      where('date', '>=', start), where('date', '<=', end))
    return onSnapshot(q, snap => setWasteLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [start, end])

  useEffect(() => {
    // Daily Income เก็บ doc id = YYYY-MM-DD, total = morning.total + afternoon.total
    const q = query(collection(db, COL.INCOME_RECORDS),
      where(documentId(), '>=', start), where(documentId(), '<=', end))
    return onSnapshot(q, snap => setIncomeRecords(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [start, end])

  // Helper: total ของวันนึง = morning.total + afternoon.total
  const recTotal = r => (r?.morning?.total || 0) + (r?.afternoon?.total || 0)

  const activeCut   = cutLogs.filter(l => !l.cancelled && !l.deletedAt)
  const activeWaste = wasteLogs.filter(l => !l.cancelled)
  const totalCutCost   = activeCut.reduce((s,l) => s+(l.totalCost||0), 0)
  const totalWasteCost = activeWaste.reduce((s,l) => s+(l.totalCost||0), 0)
  const totalRevenue   = incomeRecords.reduce((s,r) => s+recTotal(r), 0)
  const grossProfit    = totalRevenue - totalCutCost
  const foodCostPct    = totalRevenue > 0 ? (totalCutCost / totalRevenue * 100) : 0
  const cutCount       = activeCut.length
  const costPerCut     = cutCount > 0 ? totalCutCost / cutCount : 0
  // Effective Use % = (cut − waste) / cut × 100
  const effectivePct   = totalCutCost > 0
    ? Math.max(0, (totalCutCost - totalWasteCost) / totalCutCost * 100)
    : 100

  // Day keys ใน range
  const allDayKeys = getDayKeys(start, end)
  // เลือก aggregation mode ตาม period
  const isLong = period === '3months' || (period === 'custom' && allDayKeysLengthOver(start, end, 60))   // ~60+ วัน — aggregate รายสัปดาห์
  const isMonth = period === 'thisMonth'

  // Daily aggregation
  const dayCostMap = {}, dayRevMap = {}
  allDayKeys.forEach(k => { dayCostMap[k] = 0; dayRevMap[k] = 0 })
  activeCut.forEach(l => { if (dayCostMap[l.date] != null) dayCostMap[l.date] += (l.totalCost||0) })
  incomeRecords.forEach(r => { if (dayRevMap[r.id] != null) dayRevMap[r.id] += recTotal(r) })

  // Build bar buckets — รายวันหรือรายสัปดาห์
  function buildBuckets() {
    if (!isLong) {
      // รายวัน
      return allDayKeys.map(k => ({
        key: k, label: dayAbbr(k),
        cost: dayCostMap[k] || 0,
        revenue: dayRevMap[k] || 0,
        isWeekend: [0, 6].includes(new Date(k).getDay()),
      }))
    }
    // รายสัปดาห์ (12 weeks)
    const weeks = {}
    allDayKeys.forEach(k => {
      const d = new Date(k)
      // ISO week start (จันทร์)
      const day = d.getDay() || 7
      d.setDate(d.getDate() - (day - 1))
      const wKey = d.toISOString().slice(0, 10)
      if (!weeks[wKey]) weeks[wKey] = { key: wKey, label: `${d.getDate()}/${d.getMonth()+1}`,
        cost: 0, revenue: 0 }
      weeks[wKey].cost += dayCostMap[k] || 0
      weeks[wKey].revenue += dayRevMap[k] || 0
    })
    return Object.values(weeks)
  }
  const buckets = buildBuckets()
  // ค่าสูงสุดของ revenue (เพราะ stacked bar ใช้ revenue เป็น total)
  const maxBar = Math.max(...buckets.map(b => Math.max(b.revenue, b.cost)), 1)

  // เปรียบเทียบ วันธรรมดา vs วันหยุด (เฉพาะรายสัปดาห์/รายเดือน)
  const weekdayBuckets = !isLong ? buckets.filter(b => !b.isWeekend) : []
  const weekendBuckets = !isLong ? buckets.filter(b => b.isWeekend) : []
  const avg = arr => arr.length ? arr.reduce((s,b) => s+b.cost, 0) / arr.length : 0
  const avgWeekday = avg(weekdayBuckets)
  const avgWeekend = avg(weekendBuckets)
  const compareDiff = avgWeekday > 0 ? ((avgWeekend - avgWeekday) / avgWeekday * 100) : 0

  // top items — by qty + by cost (ใช้ displayName จาก master data)
  const itemLookup = {}
  analyzeItems.forEach(i => { itemLookup[i.id] = i })
  const itemMap = {}
  const itemCostMap = {}
  activeCut.forEach(l => {
    (l.items||[]).forEach(it => {
      const master = itemLookup[it.itemId] || {}
      const displayName = master.displayName || it.itemName
      const key = it.itemId || it.itemName  // group by itemId เพื่อนับรวมต่อให้ชื่อต่าง
      if (!itemMap[key]) itemMap[key] = { name: displayName, qty: 0,
        unit: master.unitUse || it.unitUse || it.unit, img: master.img || '' }
      itemMap[key].qty += (it.qtyUse || it.qty || 0)
      if (!itemCostMap[key]) itemCostMap[key] = { name: displayName, cost: 0, img: master.img || '' }
      itemCostMap[key].cost += (it.cost || it.costTotal || 0)
    })
  })
  const top5 = Object.values(itemMap).sort((a,b) => b.qty - a.qty).slice(0,5)
  const maxQty = top5[0]?.qty || 1
  const topByCost = Object.values(itemCostMap).sort((a,b) => b.cost - a.cost).slice(0,5)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Date range pills + วันที่ในวงเล็บของช่วงที่เลือก */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {PILLS.map(p => (
          <button key={p.id} onClick={() => setPeriod(p.id)}
            style={{ border: 'none', borderRadius: 20, padding: '6px 14px', fontSize: 12,
              fontWeight: 700, cursor: 'pointer', transition: 'all .15s',
              background: period === p.id ? 'var(--red)' : '#F2F2F7',
              color: period === p.id ? '#fff' : '#6B7280' }}>
            {p.label}
          </button>
        ))}
      </div>

      {/* แสดงช่วงวันที่ของ pill ที่เลือกอยู่ */}
      {period !== 'custom' && (
        <div style={{ fontSize: 11, color: '#6B7280', marginTop: -8 }}>
          ({toThaiShort(start)} – {toThaiShort(end)})
        </div>
      )}

      {/* Custom date inputs */}
      {period === 'custom' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          background: '#F9FAFB', borderRadius: 12, padding: '10px 12px', marginTop: -4 }}>
          <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 700 }}>จาก</span>
          <input type="date" value={custom.start}
            onChange={e => setCustom(c => ({ ...c, start: e.target.value }))}
            style={{ fontSize: 12, padding: '5px 8px', borderRadius: 8,
              border: '1px solid #D1D5DB', background: '#fff', fontFamily: 'Sarabun' }} />
          <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 700 }}>ถึง</span>
          <input type="date" value={custom.end}
            onChange={e => setCustom(c => ({ ...c, end: e.target.value }))}
            style={{ fontSize: 12, padding: '5px 8px', borderRadius: 8,
              border: '1px solid #D1D5DB', background: '#fff', fontFamily: 'Sarabun' }} />
          {custom.start && custom.end && (
            <span style={{ fontSize: 11, color: '#16A34A', fontWeight: 700, marginLeft: 'auto' }}>
              ✓ {toThaiShort(start)} – {toThaiShort(end)}
            </span>
          )}
        </div>
      )}

      {/* Hero card — Food Cost % ใหญ่ */}
      <div style={{ borderRadius: 18, padding: '20px 18px',
        background: foodCostPct > 35
          ? 'linear-gradient(135deg,#DC2626 0%,#991B1B 100%)'
          : 'linear-gradient(135deg,#16A34A 0%,#15803D 100%)',
        boxShadow: '0 4px 16px rgba(22,163,74,0.25)' }}>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,.85)', marginBottom: 4 }}>
          📊 Food Cost %
        </div>
        <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 40, color: '#fff',
          lineHeight: 1.1 }}>
          {foodCostPct.toFixed(1)}%
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,.75)', marginTop: 6 }}>
          ต้นทุน {thb(totalCutCost)} / รายได้ {thb(totalRevenue)}
        </div>
      </div>

      {/* KPI 2x2 — รายได้, ต้นทุน, Gross Profit, Food Cost % */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {[
          { label: '💰 รายได้รวม', value: thb(totalRevenue), color: '#16A34A' },
          { label: '📦 ต้นทุนรวม', value: thb(totalCutCost), color: '#FF3B30' },
          { label: '✨ Gross Profit', value: thb(grossProfit), color: grossProfit >= 0 ? '#16A34A' : '#DC2626' },
          { label: '📊 Food Cost %', value: `${foodCostPct.toFixed(1)}%`, color: foodCostPct > 35 ? '#DC2626' : '#16A34A' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 14, padding: '10px 12px',
            border: '1px solid #F3F4F6', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize: 10, color: '#8E8E93', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 16, color: k.color }}>
              {k.value}
            </div>
          </div>
        ))}
      </div>

      {/* Mini KPI — ครั้งตัด, ของเสีย, Effective Use %, ต้นทุน/ครั้ง */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {[
          { label: '✂️ ครั้งตัดสต็อก', value: activeCut.length, color: '#1C1C1E' },
          { label: '🗑️ ของเสียรวม', value: thb(totalWasteCost), color: '#D97706' },
          { label: '✨ Effective Use %',
            value: `${effectivePct.toFixed(1)}%`,
            color: effectivePct >= 95 ? '#15803D' : effectivePct >= 85 ? '#D97706' : '#DC2626' },
          { label: '💵 ต้นทุน/ครั้ง', value: thb(costPerCut), color: '#1C1C1E' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 14, padding: '8px 12px',
            border: '1px solid #F3F4F6' }}>
            <div style={{ fontSize: 10, color: '#8E8E93', marginBottom: 2 }}>{k.label}</div>
            <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, color: k.color }}>
              {k.value}
            </div>
          </div>
        ))}
      </div>

      {/* Stacked Bar chart — ต้นทุน (แดง) vs Gross Profit (เขียว) = รายได้รวม */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #F3F4F6',
        padding: '14px 12px', overflow: 'visible', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13 }}>
            {isLong ? 'รายได้ vs ต้นทุน (รายสัปดาห์)' : 'รายได้ vs ต้นทุน (รายวัน)'}
          </div>
          <div style={{ display: 'flex', gap: 10, fontSize: 10 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--red)' }}/>
              <span style={{ color: '#6B7280' }}>ต้นทุน</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: '#16A34A' }}/>
              <span style={{ color: '#6B7280' }}>กำไร</span>
            </span>
          </div>
        </div>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end',
          gap: isLong ? 4 : (isMonth ? 2 : 6), height: 140,
          overflow: 'visible', paddingTop: 4 }}
          onMouseLeave={() => setHoverIdx(null)}>
          {buckets.map((b, i) => {
            const total = Math.max(b.revenue, b.cost)
            const totalH = (total / maxBar) * 110
            const costH  = total > 0 ? (b.cost / total) * totalH : 0
            const profit = b.revenue - b.cost
            const profitH = profit > 0 && b.revenue > 0 ? (profit / total) * totalH : 0
            const showVal = b.revenue > 0 || b.cost > 0
            const isHover = hoverIdx === i
            return (
              <div key={b.key + i}
                onMouseEnter={e => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setHoverIdx(i)
                  setHoverPos({ x: r.left + r.width / 2, y: r.top })
                }}
                onClick={e => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setHoverIdx(idx => idx === i ? null : i)
                  setHoverPos({ x: r.left + r.width / 2, y: r.top })
                }}
                style={{ flex: '1 1 0', minWidth: isLong ? 28 : (isMonth ? 12 : 30),
                  display: 'flex', flexDirection: 'column', cursor: showVal ? 'pointer' : 'default',
                  alignItems: 'center', justifyContent: 'flex-end', height: '100%',
                  position: 'relative' }}>
                {showVal && !isMonth && (
                  <div style={{ fontSize: 8, color: '#16A34A', fontWeight: 700, marginBottom: 1,
                    whiteSpace: 'nowrap' }}>
                    {b.revenue >= 1000 ? `${(b.revenue/1000).toFixed(1)}K` : b.revenue.toFixed(0)}
                  </div>
                )}
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column',
                  height: totalH, borderRadius: '4px 4px 0 0', overflow: 'hidden',
                  opacity: hoverIdx != null && !isHover ? 0.45 : 1, transition: 'opacity .15s' }}>
                  {profitH > 0 && (
                    <div style={{ width: '100%', height: profitH, background: '#16A34A' }}/>
                  )}
                  {costH > 0 && (
                    <div style={{ width: '100%', height: costH, background: 'var(--red)' }}/>
                  )}
                </div>
                <div style={{ fontSize: isMonth ? 8 : 10, color: b.isWeekend ? '#DC2626' : '#8E8E93',
                  marginTop: 4, fontWeight: 700 }}>
                  {b.label}
                </div>
                {/* Tooltip rendered ที่ระดับ document (fixed) — ดูข้างล่าง */}
              </div>
            )
          })}
        </div>
      </div>

      {/* Fixed-position tooltip (อยู่นอก chart container เพื่อไม่โดน overflow clip) */}
      {hoverIdx != null && buckets[hoverIdx] && (() => {
        const b = buckets[hoverIdx]
        const profit = b.revenue - b.cost
        const showVal = b.revenue > 0 || b.cost > 0
        if (!showVal) return null
        return (
          <div style={{ position: 'fixed', left: hoverPos.x, top: hoverPos.y,
            transform: 'translate(-50%, calc(-100% - 10px))',
            zIndex: 9999, pointerEvents: 'none',
            background: '#1F2937', color: '#fff', borderRadius: 10,
            padding: '10px 12px', fontSize: 11, lineHeight: 1.6, minWidth: 160,
            boxShadow: '0 8px 24px rgba(0,0,0,.32)' }}>
            <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4,
              borderBottom: '1px solid #374151', paddingBottom: 4 }}>
              📅 {!isLong ? toThaiShort(b.key) : `สัปดาห์ ${b.label}`}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: '#10B981' }}>💰 รายได้</span>
              <span style={{ fontWeight: 700 }}>{thb(b.revenue)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: '#F87171' }}>📦 ต้นทุน</span>
              <span style={{ fontWeight: 700 }}>{thb(b.cost)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8,
              borderTop: '1px solid #374151', paddingTop: 4, marginTop: 2 }}>
              <span style={{ color: profit >= 0 ? '#34D399' : '#F87171' }}>
                {profit >= 0 ? '✨ กำไร' : '⚠️ ขาดทุน'}
              </span>
              <span style={{ fontWeight: 700 }}>{thb(profit)}</span>
            </div>
            {b.revenue > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8,
                marginTop: 2, color: '#9CA3AF', fontSize: 10 }}>
                <span>Food Cost</span>
                <span>{((b.cost / b.revenue) * 100).toFixed(1)}%</span>
              </div>
            )}
            <div style={{ position: 'absolute', top: '100%', left: '50%',
              transform: 'translateX(-50%)', width: 0, height: 0,
              borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
              borderTop: '6px solid #1F2937' }} />
          </div>
        )
      })()}

      {/* Comparison: weekday vs weekend (เฉพาะรายวัน) */}
      {!isLong && (avgWeekday > 0 || avgWeekend > 0) && (
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #F3F4F6', padding: '14px 12px' }}>
          <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
            💸 เปรียบเทียบ <span style={{ color: '#DC2626' }}>ต้นทุนวัตถุดิบเฉลี่ย/วัน</span>
          </div>
          <div style={{ fontSize: 10, color: '#8E8E93', marginBottom: 12 }}>
            (วันธรรมดา จ-ศ vs วันหยุด ส-อา)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ background: '#F2F2F7', borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>📅 วันธรรมดา (จ-ศ)</div>
              <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 16, color: '#1C1C1E' }}>
                {thb(avgWeekday)}
              </div>
              <div style={{ fontSize: 10, color: '#8E8E93', marginTop: 2 }}>ต้นทุนเฉลี่ย/วัน</div>
            </div>
            <div style={{ background: '#FEF2F2', borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: '#991B1B', marginBottom: 4 }}>🎉 วันหยุด (ส-อา)</div>
              <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 16, color: '#DC2626' }}>
                {thb(avgWeekend)}
              </div>
              <div style={{ fontSize: 10, color: '#991B1B', marginTop: 2 }}>
                {compareDiff !== 0
                  ? <span>{compareDiff > 0 ? '▲ สูงกว่าวันธรรมดา' : '▼ ต่ำกว่าวันธรรมดา'} {Math.abs(compareDiff).toFixed(0)}%</span>
                  : <span>เท่ากับวันธรรมดา</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Top 5 วัตถุดิบที่ใช้มาก (จำนวน) */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #F3F4F6', padding: '14px 12px' }}>
        <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, marginBottom: 12 }}>
          📦 Top 5 วัตถุดิบที่ใช้มาก (ตามจำนวน)
        </div>
        {top5.length === 0 ? <EmptyState /> : top5.map((it, i) => (
          <div key={it.name} style={{ marginBottom: i < top5.length-1 ? 10 : 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{it.img} {it.name}</span>
              <span style={{ fontSize: 12, color: '#8E8E93' }}>{it.qty.toFixed(2)} {it.unit}</span>
            </div>
            <div style={{ height: 6, background: '#F2F2F7', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: 4, background: 'var(--red)',
                width: `${(it.qty / maxQty) * 100}%`, transition: 'width .4s' }} />
            </div>
          </div>
        ))}
      </div>

      {/* Top 5 วัตถุดิบที่ต้นทุนสูง */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #F3F4F6', padding: '14px 12px' }}>
        <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, marginBottom: 12 }}>
          💸 Top 5 วัตถุดิบที่ต้นทุนสูงสุด
        </div>
        {topByCost.length === 0 || topByCost[0]?.cost === 0
          ? <EmptyState />
          : topByCost.map((it, i) => {
              const pct = totalCutCost > 0 ? (it.cost / totalCutCost * 100) : 0
              return (
                <div key={it.name} style={{ marginBottom: i < topByCost.length-1 ? 10 : 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{it.img} {it.name}</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#8E8E93' }}>{pct.toFixed(1)}%</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#DB2777' }}>{thb(it.cost)}</span>
                    </div>
                  </div>
                  <div style={{ height: 6, background: '#F2F2F7', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 4, background: '#DB2777',
                      width: `${pct}%`, transition: 'width .4s' }} />
                  </div>
                </div>
              )
            })
        }
      </div>
    </div>
  )
}

/* ── WasteAnalysisTab ──────────────────────────────────────────────────── */
function WasteAnalysisTab() {
  const [period, setPeriod] = useState('7days')
  const [wasteLogs, setWasteLogs] = useState([])
  const [cutLogs, setCutLogs] = useState([])     // ใช้คำนวณ Effective Use %
  const [revenue, setRevenue] = useState(0)

  const PILLS = [
    { id: '7days',     label: '7 วัน' },
    { id: '30days',    label: '30 วัน' },
    { id: 'thisMonth', label: 'เดือนนี้' },
  ]

  function getWasteRange(p) {
    const today = new Date()
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    const todayKey = fmt(today)
    if (p === '7days') {
      const s = new Date(today); s.setDate(today.getDate()-6)
      return { start: fmt(s), end: todayKey }
    }
    if (p === '30days') {
      const s = new Date(today); s.setDate(today.getDate()-29)
      return { start: fmt(s), end: todayKey }
    }
    if (p === 'thisMonth') {
      const s = new Date(today.getFullYear(), today.getMonth(), 1)
      const e = new Date(today.getFullYear(), today.getMonth()+1, 0)
      return { start: fmt(s), end: fmt(e) }
    }
    return { start: todayKey, end: todayKey }
  }

  const { start, end } = getWasteRange(period)

  useEffect(() => {
    const q = query(collection(db, COL.WASTE_LOGS),
      where('date', '>=', start), where('date', '<=', end))
    return onSnapshot(q, snap => setWasteLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [start, end])

  useEffect(() => {
    const q = query(collection(db, COL.CUT_STOCK_LOGS),
      where('date', '>=', start), where('date', '<=', end))
    return onSnapshot(q, snap => setCutLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [start, end])

  useEffect(() => {
    const q = query(collection(db, COL.INCOME_RECORDS),
      where(documentId(), '>=', start), where(documentId(), '<=', end))
    return onSnapshot(q, snap => {
      const tot = snap.docs.reduce((s,d) => {
        const r = d.data() || {}
        return s + (r.morning?.total || 0) + (r.afternoon?.total || 0)
      }, 0)
      setRevenue(tot)
    })
  }, [start, end])

  const active = wasteLogs.filter(l => !l.cancelled)
  const activeCut = cutLogs.filter(l => !l.cancelled && !l.deletedAt)
  const totalCutCost   = activeCut.reduce((s,l) => s+(l.totalCost||0), 0)
  const totalWasteCost = active.reduce((s,l) => s+(l.totalCost||0), 0)
  const wastePct = revenue > 0 ? (totalWasteCost / revenue * 100) : 0
  // Effective Use % = (cut - waste) / cut × 100 — % ของวัตถุดิบที่ตัดมาแล้วใช้ได้จริง
  const effectivePct = totalCutCost > 0
    ? Math.max(0, (totalCutCost - totalWasteCost) / totalCutCost * 100)
    : 100

  const fruit   = active.filter(l => l.type === 'fruit_daily')
  const closing = active.filter(l => l.type === 'closing')

  function groupByItem(logs) {
    const map = {}
    logs.forEach(l => {
      const k = l.itemName || 'ไม่ระบุ'
      if (!map[k]) map[k] = { name: k, qty: 0, unit: l.unit||'', cost: 0 }
      map[k].qty  += (l.qty||0)
      map[k].cost += (l.totalCost||0)
    })
    return Object.values(map).sort((a,b) => b.cost - a.cost)
  }

  const fruitGroups   = groupByItem(fruit)
  const closingGroups = groupByItem(closing)
  const worstItem = [...fruitGroups,...closingGroups].sort((a,b)=>b.cost-a.cost)[0]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Pills */}
      <div style={{ display: 'flex', gap: 6 }}>
        {PILLS.map(p => (
          <button key={p.id} onClick={() => setPeriod(p.id)}
            style={{ border: 'none', borderRadius: 20, padding: '6px 14px', fontSize: 12,
              fontWeight: 700, cursor: 'pointer',
              background: period === p.id ? 'var(--red)' : '#F2F2F7',
              color: period === p.id ? '#fff' : '#6B7280' }}>
            {p.label}
          </button>
        ))}
      </div>

      {/* KPI 2×2 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {[
          { label: '💰 มูลค่าของเสีย', value: thb(totalWasteCost), color: '#D97706',
            sub: `${active.length} ครั้ง` },
          { label: '📊 % ของเสีย (Revenue)', value: `${wastePct.toFixed(1)}%`,
            color: wastePct > 5 ? '#DC2626' : '#16A34A',
            sub: `ของรายได้ ${thb(revenue)}` },
          { label: '🍓 ต้นทุนวัตถุดิบ', value: thb(totalCutCost), color: '#DB2777',
            sub: 'จาก cut_stock_logs' },
          { label: '✨ Effective Use %',
            value: `${effectivePct.toFixed(1)}%`,
            color: effectivePct >= 95 ? '#15803D' : effectivePct >= 85 ? '#D97706' : '#DC2626',
            sub: '(cut − waste) ÷ cut' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 14, padding: '10px 12px',
            border: '1px solid #F3F4F6', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize: 10, color: '#8E8E93', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 17, color: k.color }}>
              {k.value}
            </div>
            {k.sub && (
              <div style={{ fontSize: 9, color: '#9CA3AF', marginTop: 2 }}>{k.sub}</div>
            )}
          </div>
        ))}
      </div>

      {/* Effective Use Insight Bar */}
      {totalCutCost > 0 && (
        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #F3F4F6',
          padding: '14px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 700 }}>
              💡 ของที่ตัดมาแล้วใช้ได้จริง
            </span>
            <span style={{ fontSize: 11, color: '#9CA3AF' }}>
              {thb(totalCutCost - totalWasteCost)} / {thb(totalCutCost)}
            </span>
          </div>
          <div style={{ position: 'relative', height: 22, background: '#F3F4F6', borderRadius: 11,
            overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${effectivePct}%`,
              background: effectivePct >= 95 ? '#16A34A' : effectivePct >= 85 ? '#D97706' : '#DC2626',
              transition: 'width .4s' }} />
            <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>
              {effectivePct.toFixed(1)}% ใช้ได้จริง · {(100 - effectivePct).toFixed(1)}% เสีย
            </div>
          </div>
        </div>
      )}

      {/* Insight */}
      {worstItem && (
        <div style={{ background: '#FEF9C3', borderRadius: 14, padding: '12px 14px',
          border: '1px solid #FDE68A' }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: '#92400E', marginBottom: 4 }}>
            💡 สินค้าที่เสียมากสุด
          </div>
          <div style={{ fontSize: 13, color: '#78350F', fontWeight: 700 }}>{worstItem.name}</div>
          <div style={{ fontSize: 11, color: '#92400E', marginTop: 2 }}>
            {worstItem.qty.toFixed(2)} {worstItem.unit} · {thb(worstItem.cost)}
          </div>
        </div>
      )}

      {/* Fruit waste */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #F3F4F6', padding: '14px 12px' }}>
        <SectionHeader icon="🍋" label="ผลไม้เสียระหว่างวัน" count={fruitGroups.length} />
        {fruitGroups.length === 0 ? <EmptyState /> : fruitGroups.map(it => (
          <div key={it.name} style={{ display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #F9FAFB' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{it.name}</span>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: '#D97706', fontWeight: 700 }}>
                {it.qty.toFixed(2)} {it.unit}
              </div>
              {it.cost > 0 && <div style={{ fontSize: 11, color: '#92600A' }}>{thb(it.cost)}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Closing waste */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #F3F4F6', padding: '14px 12px' }}>
        <SectionHeader icon="🌙" label="ของเสียปิดร้าน" count={closingGroups.length} />
        {closingGroups.length === 0 ? <EmptyState /> : closingGroups.map(it => (
          <div key={it.name} style={{ display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #F9FAFB' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{it.name}</span>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: '#6366F1', fontWeight: 700 }}>
                {it.qty.toFixed(2)} {it.unit}
              </div>
              {it.cost > 0 && <div style={{ fontSize: 11, color: '#4338CA' }}>{thb(it.cost)}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════
   Main Report component
   ══════════════════════════════════════════════════════════════════════ */
export default function Report() {
  const { isOwner } = useSession()
  const [subTab, setSubTab] = useState('daily')
  const [date, setDate] = useState(toDateKey())
  const dateInputRef = useRef(null)

  /* ── data states ── */
  const [cutLogs,       setCutLogs]       = useState([])
  const [wasteLogs,     setWasteLogs]     = useState([])
  const [transfers,     setTransfers]     = useState([])
  const [refillReqs,    setRefillReqs]    = useState([])
  const [auditLogs,     setAuditLogs]     = useState([])
  const [reportItems,   setReportItems]   = useState([])
  const [catOrder,      setCatOrder]      = useState([])
  const [cmCosts,       setCmCosts]       = useState({})
  const [loadingDate,   setLoadingDate]   = useState(false)

  /* ── cancel sheet state ── */
  const [cancelEntry,  setCancelEntry]  = useState(null)
  const [cancelLabel,  setCancelLabel]  = useState('')
  const [cancelHandler,setCancelHandler]= useState(null)

  /* ── firestore subscriptions ── */
  useEffect(() => {
    setLoadingDate(true)
    const q = query(collection(db, COL.CUT_STOCK_LOGS), where('date', '==', date))
    return onSnapshot(q, snap => {
      setCutLogs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoadingDate(false)
    })
  }, [date])

  useEffect(() => {
    const q = query(collection(db, COL.WASTE_LOGS), where('date', '==', date))
    return onSnapshot(q, snap => setWasteLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [date])

  useEffect(() => {
    return onSnapshot(collection(db, COL.TRANSFER_ORDERS),
      snap => setTransfers(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [])

  // Refill Requests — ดึงทุก status เพื่อแสดงใน daily log ตามวันที่แจ้ง
  useEffect(() => {
    const q = query(collection(db, COL.REFILL_REQUESTS),
      where('status', 'in', ['pending', 'processing', 'done', 'cancelled']))
    return onSnapshot(q, snap => {
      setRefillReqs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    }, err => console.error('RF report:', err))
  }, [])

  useEffect(() => {
    const q = query(collection(db, COL.AUDIT_LOGS), orderBy('timestamp', 'desc'))
    return onSnapshot(q, snap => setAuditLogs(snap.docs.slice(0, 150).map(d => ({ id: d.id, ...d.data() }))))
  }, [])

  useEffect(() => {
    const unsubCat = onSnapshot(doc(db, COL.APP_SETTINGS, 'categories'), snap => {
      if (snap.exists() && Array.isArray(snap.data().list)) {
        setCatOrder(snap.data().list.map(c => c.name))
      }
    })
    const unsub = onSnapshot(collection(db, COL.ITEMS),
      snap => setReportItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
    getDoc(doc(db, 'mixue_data', 'mixue-cost-manager')).then(snap => {
      if (!snap.exists()) return
      const lib = snap.data().library || []
      const map = {}
      lib.forEach(it => {
        const levels = it.levels || []
        const rawPrice = it.basePrice || it.price || it.total || 0
        const convBuyToUse = levels[1]?.qty || 1
        const convUseToSub = levels[2]?.qty || 1
        const costPerUse = rawPrice > 0 ? rawPrice / convBuyToUse : (it.unitPrice || 0) * convUseToSub
        map[it.name] = { costPerUse, unitPrice: it.unitPrice || 0 }
      })
      setCmCosts(map)
    })
    return () => { unsub(); unsubCat() }
  }, [])

  /* ── derived data ── */
  const fruitWaste   = wasteLogs.filter(l => l.type === 'fruit_daily')
  const closingWaste = wasteLogs.filter(l => l.type === 'closing')
  const receiveLogs  = auditLogs.filter(l =>
    l.action === 'receive' && tsToDateKey(l.timestamp) === date)
  // TF ที่สร้างในวันที่เลือก (ใช้ createdAt)
  const dailyTransfers = transfers.filter(t => {
    if (!t.createdAt) return false
    return tsToDateKey(t.createdAt) === date
  })
  // RF ที่แจ้งในวันที่เลือก (ใช้ requestedAt)
  const dailyRFs = refillReqs.filter(r => {
    if (!r.requestedAt) return false
    return tsToDateKey(r.requestedAt) === date
  })
  // Audit logs เฉพาะวันที่เลือก
  const dailyAuditLogs = auditLogs.filter(l => {
    if (!l.timestamp) return false
    return tsToDateKey(l.timestamp) === date
  })

  /* ── cancel helpers ── */
  function openCancel(entry, label, handler) {
    setCancelEntry(entry)
    setCancelLabel(label)
    setCancelHandler(() => handler)
  }

  async function handleConfirmCancel(entry, reason) {
    if (cancelHandler) await cancelHandler(entry, reason)
  }

  async function cancelCutLog(log, reason) {
    // ── ยกเลิก cut log ทั้งใบ + restore stock_balances + บันทึก movement ──
    const phone = window._bizSession?.phone || ''
    const sName = window._bizSession?.name || ''
    const now = serverTimestamp()
    const batch = writeBatch(db)
    // 1. ทำ flag cancelled
    batch.update(doc(db, COL.CUT_STOCK_LOGS, log.id), {
      cancelled: true, cancelReason: reason,
      cancelledBy: sName, cancelledAt: now,
    })
    // 2. restore stock_balances + movement สำหรับทุก item ใน cut log
    const items = (log.items || []).filter(it => !it.cancelled)
    for (const it of items) {
      if (!it.itemId) continue       // ข้าม item ไม่มี id (compound เก่า)
      const balId = `${log.warehouseId}_${it.itemId}`
      const balRef = doc(db, COL.STOCK_BALANCES, balId)
      // fallback chain: qtyUse → qty (log เก่า) → 0
      const restoreQty = Number(it.qtyUse) || Number(it.qty) || 0
      if (restoreQty <= 0) continue   // ป้องกัน increment(0) ที่ไม่มีผล
      const restoreUnit = it.unitUse || it.unit || ''
      batch.set(balRef, {
        warehouseId: log.warehouseId,
        itemId:      it.itemId,
        qty:         increment(restoreQty),
        unit:        restoreUnit,
        lastUpdated: now,
        lastUpdatedBy: phone,
      }, { merge: true })
      const movRef = doc(collection(db, COL.STOCK_MOVEMENTS))
      batch.set(movRef, {
        type:         'cut_cancel',
        itemId:       it.itemId,
        itemName:     it.itemName,
        warehouseId:  log.warehouseId,
        qty:          restoreQty,
        unit:         restoreUnit,
        qtyUse:       restoreQty,
        unitUse:      restoreUnit,
        adjustReason: `ยกเลิกตัดสต็อก: ${reason}`,
        note:         `restore จาก cut log ${log.id?.slice(-6) || ''}`,
        staffPhone:   phone,
        staffName:    sName,
        timestamp:    now,
      })
    }
    // 3. audit
    const audRef = doc(collection(db, COL.AUDIT_LOGS))
    batch.set(audRef, {
      action: 'cancel_cut', staffPhone: phone, staffName: sName,
      warehouseId: log.warehouseId,
      detail: `ยกเลิกตัดสต็อก (ใบ #${log.id?.slice(-6)}) — ${items.length} รายการ — เหตุผล: ${reason}`,
      timestamp: now,
    })
    await batch.commit()
  }

  /** Restore stock เฉพาะ item ที่ cancelled ไปแล้ว (recovery) — ไม่แก้ flag */
  async function restoreCutLogItem(log, itemIdx) {
    const phone = window._bizSession?.phone || ''
    const sName = window._bizSession?.name || ''
    const target = (log.items || [])[itemIdx]
    if (!target) return
    if (!target.itemId) { alert('item นี้ไม่มี id — restore ไม่ได้'); return }
    const restoreQty = Number(target.qtyUse) || Number(target.qty) || 0
    if (restoreQty <= 0) { alert('qty = 0 — ไม่มีอะไรให้ restore'); return }
    if (!confirm(`คืน ${restoreQty} ${target.unitUse || target.unit || ''} ของ ${target.itemName} กลับเข้า stock?`)) return
    const now = serverTimestamp()
    const batch = writeBatch(db)
    const balRef = doc(db, COL.STOCK_BALANCES, `${log.warehouseId}_${target.itemId}`)
    const restoreUnit = target.unitUse || target.unit || ''
    batch.set(balRef, {
      warehouseId: log.warehouseId,
      itemId:      target.itemId,
      qty:         increment(restoreQty),
      unit:        restoreUnit,
      lastUpdated: now,
      lastUpdatedBy: phone,
    }, { merge: true })
    const movRef = doc(collection(db, COL.STOCK_MOVEMENTS))
    batch.set(movRef, {
      type:         'cut_restore',
      itemId:       target.itemId,
      itemName:     target.itemName,
      warehouseId:  log.warehouseId,
      qty:          restoreQty,
      unit:         restoreUnit,
      qtyUse:       restoreQty,
      unitUse:      restoreUnit,
      adjustReason: `Restore manual จากที่ cancelled แล้ว`,
      note:         `cut log ${log.id?.slice(-6) || ''} · idx ${itemIdx}`,
      staffPhone:   phone,
      staffName:    sName,
      timestamp:    now,
    })
    // mark ใน log ว่า restored
    const newItems = (log.items || []).map((it, i) => i === itemIdx
      ? { ...it, stockRestored: true, stockRestoredAt: new Date().toISOString() }
      : it)
    batch.update(doc(db, COL.CUT_STOCK_LOGS, log.id), { items: newItems })
    const audRef = doc(collection(db, COL.AUDIT_LOGS))
    batch.set(audRef, {
      action: 'restore_cut_item', staffPhone: phone, staffName: sName,
      warehouseId: log.warehouseId,
      detail: `คืน stock manual: ${target.itemName} ${restoreQty} ${restoreUnit} (ใบ #${log.id?.slice(-6)})`,
      timestamp: now,
    })
    await batch.commit()
  }

  /** ยกเลิก line item เดียวใน cut_stock_log + restore stock ของเฉพาะ item นั้น */
  async function cancelCutLogItem(log, itemIdx, reason) {
    const phone = window._bizSession?.phone || ''
    const sName = window._bizSession?.name || ''
    const now = serverTimestamp()
    const items = log.items || []
    const target = items[itemIdx]
    if (!target) return
    const batch = writeBatch(db)
    // 1. ทำ flag cancelled ที่ item นั้น + update log
    const newItems = items.map((it, i) => i === itemIdx
      ? { ...it, cancelled: true, cancelReason: reason, cancelledAt: new Date().toISOString(), cancelledBy: sName }
      : it
    )
    // คำนวณ totalCost ใหม่ (ตัด cost ของ item ที่ cancel ออก)
    const newTotalCost = newItems
      .filter(it => !it.cancelled)
      .reduce((s, it) => s + (Number(it.costTotal) || 0), 0)
    batch.update(doc(db, COL.CUT_STOCK_LOGS, log.id), {
      items: newItems,
      totalCost: newTotalCost,
      lastEditedAt: now,
      lastEditedBy: sName,
    })
    // 2. restore stock_balance + movement
    const restoreQty = Number(target.qtyUse) || Number(target.qty) || 0
    const restoreUnit = target.unitUse || target.unit || ''
    if (!target.itemId) {
      console.warn('[cancelCutLogItem] missing itemId — cannot restore stock', target)
    } else if (restoreQty <= 0) {
      console.warn('[cancelCutLogItem] qty=0 — nothing to restore', target)
    } else {
      const balRef = doc(db, COL.STOCK_BALANCES, `${log.warehouseId}_${target.itemId}`)
      batch.set(balRef, {
        warehouseId: log.warehouseId,
        itemId:      target.itemId,
        qty:         increment(restoreQty),
        unit:        restoreUnit,
        lastUpdated: now,
        lastUpdatedBy: phone,
      }, { merge: true })
      const movRef = doc(collection(db, COL.STOCK_MOVEMENTS))
      batch.set(movRef, {
        type:         'cut_cancel_item',
        itemId:       target.itemId,
        itemName:     target.itemName,
        warehouseId:  log.warehouseId,
        qty:          restoreQty,
        unit:         restoreUnit,
        qtyUse:       restoreQty,
        unitUse:      restoreUnit,
        adjustReason: `ยกเลิก item: ${reason}`,
        note:         `cut log ${log.id?.slice(-6) || ''} · idx ${itemIdx}`,
        staffPhone:   phone,
        staffName:    sName,
        timestamp:    now,
      })
    }
    // 3. audit
    const audRef = doc(collection(db, COL.AUDIT_LOGS))
    batch.set(audRef, {
      action: 'cancel_cut_item', staffPhone: phone, staffName: sName,
      warehouseId: log.warehouseId,
      detail: `ยกเลิก ${target.itemName} ${target.qtyUse} ${target.unitUse} (ใบ #${log.id?.slice(-6)}) — เหตุผล: ${reason}`,
      timestamp: now,
    })
    await batch.commit()
  }

  async function cancelWasteLog(log, reason) {
    const phone = window._bizSession?.phone || ''
    const staffName = window._bizSession?.name || ''
    const batch = writeBatch(db)
    // ── ถ้า log นี้เคยตัด stock จริง (fruit_daily) → คืนเข้า warehouse เดิม ──
    if (log.deductedStock && log.warehouseId && log.itemId) {
      const qtyUse = Number(log.qtyUse) || Number(log.qty) || 0
      if (qtyUse > 0) {
        const balRef = doc(db, COL.STOCK_BALANCES, balanceId(log.warehouseId, log.itemId))
        batch.set(balRef, {
          warehouseId: log.warehouseId, itemId: log.itemId,
          qty: increment(qtyUse), lastUpdated: serverTimestamp(),
        }, { merge: true })
        // movement = reverse
        batch.set(doc(collection(db, COL.STOCK_MOVEMENTS)), {
          type: 'waste_reverse',
          itemId: log.itemId, itemName: log.itemName,
          warehouseId: log.warehouseId,
          qty: qtyUse, qtyUse,
          unit: log.unitUse || log.unit || '',
          unitUse: log.unitUse || log.unit || '',
          adjustReason: 'ยกเลิกของเสีย (คืน stock)',
          note: `waste log #${log.id?.slice(-6) || ''} · ${reason}`,
          staffPhone: phone, staffName, timestamp: serverTimestamp(),
        })
      }
    }
    batch.update(doc(db, COL.WASTE_LOGS, log.id), {
      cancelled: true, cancelReason: reason,
      cancelledBy: staffName, cancelledAt: serverTimestamp(),
      reverted: !!log.deductedStock,
    })
    batch.set(doc(collection(db, COL.AUDIT_LOGS)), {
      action: 'cancel_waste', staffPhone: phone, staffName,
      detail: `ยกเลิกของเสีย ${log.itemName} ${log.qty} ${log.unit}${log.deductedStock ? ' (คืน stock แล้ว)' : ''} — เหตุผล: ${reason}`,
      timestamp: serverTimestamp()
    })
    await batch.commit()
  }

  async function cancelAuditEntry(log, reason) {
    await updateDoc(doc(db, COL.AUDIT_LOGS, log.id), {
      cancelled: true, cancelReason: reason,
      cancelledBy: window._bizSession?.name || '', cancelledAt: serverTimestamp()
    })
    await addDoc(collection(db, COL.AUDIT_LOGS), {
      action: 'cancel', staffPhone: window._bizSession?.phone || '',
      staffName: window._bizSession?.name || '',
      detail: `ยกเลิก [${log.action}] ${log.detail} — เหตุผล: ${reason}`,
      timestamp: serverTimestamp()
    })
  }

  async function cancelTransfer(tf, reason) {
    const phone = window._bizSession?.phone || ''
    const staffName = window._bizSession?.name || ''

    // ── Safe-check 1: ข้ามวันแล้ว → block ──
    const todayKey = toDateKey(new Date())
    const tfDateKey = tf.createdAt ? tsToDateKey(tf.createdAt) : todayKey
    if (tfDateKey !== todayKey) {
      window.alert(`❌ ไม่สามารถยกเลิกใบโอนข้ามวันได้\n\nใบโอนนี้สร้างเมื่อ ${tfDateKey}\nวันนี้คือ ${todayKey}\n\nกรุณาแจ้ง Owner เพื่อปรับยอดแทน`)
      return
    }

    // ── Safe-check 2: ถ้ารับแล้ว → ต้องมี stock ปลายทางพอที่จะหักคืน ──
    if (tf.status === 'received') {
      const shortages = []
      for (const it of (tf.items || [])) {
        const itemMeta = reportItems.find(i => i.id === it.itemId)
        const factor   = parseConvFactor(itemMeta?.unitConversion) || 1
        const qtyIn    = parseFloat(it.qty) || 0
        const needQtyUse = (it.unit && itemMeta?.unitBase && it.unit === itemMeta.unitBase)
          ? qtyIn * factor : qtyIn
        const toRef = doc(db, COL.STOCK_BALANCES, balanceId(tf.toWarehouseId, it.itemId))
        const toSnap = await getDoc(toRef)
        const curQty = Number(toSnap.exists() ? toSnap.data().qty : 0) || 0
        if (curQty < needQtyUse - 0.0001) {
          shortages.push(`· ${it.itemName} — ต้องคืน ${needQtyUse} ${itemMeta?.unitUse || ''} แต่เหลือ ${curQty}`)
        }
      }
      if (shortages.length > 0) {
        window.alert(`❌ ไม่สามารถยกเลิกใบโอนได้\n\nสต็อกปลายทาง (${tf.toWarehouseName}) ไม่พอที่จะคืนกลับ:\n\n${shortages.join('\n')}\n\n(อาจถูกตัดสต็อกไปแล้ว) — กรุณาปรับยอดด้วย "ปรับยอดคงคลัง" แทน`)
        return
      }
    }

    const batch = writeBatch(db)
    // ── ถ้าใบนี้รับแล้ว → ต้องคืน stock + LOT ทั้ง 2 ฝั่ง (reverse ของ confirmReceiveTransfer) ──
    if (tf.status === 'received') {
      for (const it of (tf.items || [])) {
        const itemMeta = reportItems.find(i => i.id === it.itemId)
        const factor   = parseConvFactor(itemMeta?.unitConversion) || 1
        const qtyIn    = parseFloat(it.qty) || 0
        const addQtyUse = (it.unit && itemMeta?.unitBase && it.unit === itemMeta.unitBase)
          ? qtyIn * factor : qtyIn
        // คืนต้นทาง (+) ลดปลายทาง (-)
        const fromRef = doc(db, COL.STOCK_BALANCES, balanceId(tf.fromWarehouseId, it.itemId))
        const toRef   = doc(db, COL.STOCK_BALANCES, balanceId(tf.toWarehouseId, it.itemId))
        batch.set(fromRef, { qty: increment(addQtyUse),  lastUpdated: serverTimestamp() }, { merge: true })
        batch.set(toRef,   { qty: increment(-addQtyUse), lastUpdated: serverTimestamp() }, { merge: true })
        // movement = reverse
        batch.set(doc(collection(db, COL.STOCK_MOVEMENTS)), {
          type: 'transfer_reverse', itemId: it.itemId, itemName: it.itemName,
          warehouseId: tf.fromWarehouseId, qty: addQtyUse, qtyUse: addQtyUse,
          unit: itemMeta?.unitUse || '', unitUse: itemMeta?.unitUse || '',
          adjustReason: 'ยกเลิกใบโอน (คืน stock)',
          note: `TF ${tf.tfRef || tf.id} · ${reason}`,
          staffPhone: phone, staffName, timestamp: serverTimestamp(),
        })
      }
      // คืน LOT — ลบ dest LOT ที่สร้างจาก transfer นี้ + คืน inWarehouse src LOT
      const lotsSnap = await getDocs(query(
        collection(db, COL.LOT_TRACKING), where('transferTfId', '==', tf.id)
      ))
      for (const lotDoc of lotsSnap.docs) {
        const childLot = { id: lotDoc.id, ...lotDoc.data() }
        const take = Number(childLot.inWarehouse) || 0
        // คืนเข้า src parent
        if (childLot.parentLotId && take > 0) {
          batch.update(doc(db, COL.LOT_TRACKING, childLot.parentLotId), {
            inWarehouse: increment(take), lastUpdated: serverTimestamp(),
          })
        }
        // ลบ child LOT
        batch.delete(doc(db, COL.LOT_TRACKING, childLot.id))
      }
    }
    // อัพเดทสถานะ
    batch.update(doc(db, COL.TRANSFER_ORDERS, tf.id), {
      status: 'cancelled', cancelReason: reason,
      cancelledBy: staffName, cancelledAt: serverTimestamp(),
      reverted: tf.status === 'received',
    })
    // RF ที่ link → กลับเป็น pending
    if (tf.refillRequestId) {
      batch.update(doc(db, COL.REFILL_REQUESTS, tf.refillRequestId), {
        status: 'pending', transferOrderId: null, tfRef: null,
      })
    }
    batch.set(doc(collection(db, COL.AUDIT_LOGS)), {
      action: 'cancel_transfer', staffPhone: phone, staffName,
      detail: `ยกเลิกใบโอน ${tf.tfRef || tf.id} (${tf.status === 'received' ? 'คืน stock + LOT แล้ว' : 'ยังไม่ได้รับ'}) — ${reason}`,
      timestamp: serverTimestamp(),
    })
    await batch.commit()
  }

  return (
    <div className="page-pad">

      {/* ── Topbar ── */}
      <div className="page-subbar" style={{ flexDirection: 'column', alignItems: 'stretch',
        height: 'auto', paddingBottom: 10, gap: 8 }}>
        <span className="subbar-title">รายงาน</span>

        {/* Sub-tab pills */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2,
          scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
          {SUB_TABS.filter(t => t.id !== 'analyze' || isOwner()).map(t => {
            const active = subTab === t.id
            return (
              <button key={t.id} onClick={() => setSubTab(t.id)}
                style={{ flexShrink: 0, border: 'none', borderRadius: 20,
                  padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  transition: 'all .15s', whiteSpace: 'nowrap',
                  background: active ? 'var(--red)' : '#F2F2F7',
                  color: active ? '#fff' : 'var(--txt3)' }}>
                {t.icon} {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Date + Export bar (รายวัน only) ── */}
      {subTab === 'daily' && (
        <div style={{ padding: '4px 1rem 8px' }}>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #E5E5EA',
            padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input ref={dateInputRef} type="date"
              style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
              value={date} onChange={e => setDate(e.target.value)} />
            <button onClick={() => dateInputRef.current?.showPicker?.() || dateInputRef.current?.click()}
              style={{ border: 'none', background: '#F2F2F7', borderRadius: 8, width: 32, height: 32,
                fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center',
                justifyContent: 'center', flexShrink: 0 }}>
              📅
            </button>
            <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14, flex: 1 }}>
              {toThaiDate(date)}
            </span>
            <button onClick={() => setDate(toDateKey())}
              style={{ border: 'none', background: '#FDF2F8', color: '#FF3B30', borderRadius: 8,
                padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                whiteSpace: 'nowrap' }}>
              วันนี้
            </button>
            <button style={{ border: 'none', background: 'var(--red)', color: '#fff',
              borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700,
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
              📤 Export
            </button>
          </div>
        </div>
      )}

      {/* ── Tab content ── */}
      <div style={{ padding: '0 1rem 100px', position: 'relative' }}>

        {/* Loading overlay — แสดงเมื่อเปลี่ยนวันที่ */}
        {loadingDate && subTab === 'daily' && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 20,
            background: 'rgba(245,245,247,.82)',
            backdropFilter: 'blur(3px)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 14, minHeight: 200, borderRadius: 12,
          }}>
            <style>{`
              @keyframes spin { to { transform: rotate(360deg) } }
              @keyframes fadeInLoader { from{opacity:0} to{opacity:1} }
            `}</style>
            <div style={{
              width: 44, height: 44, borderRadius: '50%',
              border: '4px solid #F3F4F6',
              borderTopColor: 'var(--red)',
              animation: 'spin .75s linear infinite, fadeInLoader .2s ease',
            }} />
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt3)',
              animation: 'fadeInLoader .3s ease' }}>
              กำลังโหลดข้อมูล...
            </div>
          </div>
        )}

        {subTab === 'daily' && (
          <DailyTab
            cutLogs={cutLogs}
            fruitWaste={fruitWaste}
            closingWaste={closingWaste}
            receiveLogs={receiveLogs}
            transfers={dailyTransfers}
            auditLogs={dailyAuditLogs}
            items={reportItems}
            catOrder={catOrder}
            cmCosts={cmCosts}
            openCancel={openCancel}
            cancelCutLog={cancelCutLog}
            cancelCutLogItem={cancelCutLogItem}
            restoreCutLogItem={restoreCutLogItem}
            cancelWasteLog={cancelWasteLog}
            cancelAuditEntry={cancelAuditEntry}
            cancelTransfer={cancelTransfer}
            dailyRFs={dailyRFs}
          />
        )}
        {subTab === 'waste'   && <WasteAnalysisTab />}
        {subTab === 'analyze' && <AnalyzeTab />}
      </div>

      {/* ── Cancel Sheet ── */}
      <CancelSheet
        entry={cancelEntry}
        label={cancelLabel}
        onClose={() => { setCancelEntry(null); setCancelHandler(null) }}
        onConfirm={handleConfirmCancel}
      />
    </div>
  )
}
