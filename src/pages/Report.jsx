import { useState, useEffect, useRef } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, orderBy, doc,
         updateDoc, addDoc, serverTimestamp, getDoc } from 'firebase/firestore'
import { useSession } from '../hooks/useSession'
import { toDateKey, toThaiDate, toThaiTime } from '../utils/formatDate'
import { COL } from '../constants/collections'

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
  { id: 'daily',   icon: '📋', label: 'รายวัน' },
  { id: 'weekly',  icon: '📅', label: 'สัปดาห์+เดือน' },
  { id: 'waste',   icon: '🗑️', label: 'ของเสีย' },
  { id: 'analyze', icon: '📊', label: 'วิเคราะห์' },
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
  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bottom-sheet">
        <div className="sheet-handle" />
        <div className="sheet-header">
          <span className="sheet-title">ยกเลิก{label}</span>
          <button className="sheet-close" onClick={onClose}>✕</button>
        </div>
        <div className="sheet-body">
          <div style={{ background: '#FFF1F2', borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 12 }}>
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
  cut_stock:         { icon: '✂️', label: 'ตัดสต็อก',       color: '#FF3B30', bg: '#FFF1F2' },
  waste:             { icon: '🗑️', label: 'ของเสีย',        color: '#D97706', bg: '#FFF7ED' },
  transfer:          { icon: '🚚', label: 'โอนสินค้า',      color: '#0369A1', bg: '#E0F2FE' },
  transfer_dispatch: { icon: '🚚', label: 'นำส่งสินค้า',    color: '#0369A1', bg: '#E0F2FE' },
  transfer_received: { icon: '📦', label: 'รับสินค้าจากโอน', color: '#16A34A', bg: '#DCFCE7' },
  refill_request:    { icon: '🔔', label: 'แจ้งเติมของ',    color: '#D97706', bg: '#FFF7ED' },
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

/* ══════════════════════════════════════════════════════════════════════
   DailyTab — 7 กลุ่มข้อมูล
   ══════════════════════════════════════════════════════════════════════ */
function DailyTab({ cutLogs, fruitWaste, closingWaste, receiveLogs, transfers, auditLogs,
                    items, cmCosts, openCancel, cancelCutLog, cancelWasteLog, cancelAuditEntry, cancelTransfer,
                    dailyRFs }) {

  /* KPI values */
  const activeCut   = cutLogs.filter(l => !l.cancelled && !l.deletedAt)
  const activeWaste = [...fruitWaste, ...closingWaste].filter(l => !l.cancelled)
  const totalCutCost   = activeCut.reduce((s, l) => s + (l.totalCost || 0), 0)
  const totalWasteCost = activeWaste.reduce((s, l) => s + calcWasteCostFromCM(l, items, cmCosts), 0)
  const pendingTf = transfers.filter(t => t.status === 'in_transit')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

      {/* ── KPI 2×2 ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
        <div style={{ background: '#fff', borderRadius: 14, padding: '12px 14px',
          border: '1px solid #F3F4F6', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 4 }}>💰 ต้นทุนวัตถุดิบ</div>
          <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 20, color: '#FF3B30' }}>
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
      <DataSection icon="✂️" label="ตัดสต็อก" count={activeCut.length}>
        {activeCut.length === 0 && cutLogs.filter(l => l.cancelled || l.deletedAt).length === 0
          ? <EmptyState msg="ยังไม่มีการตัดสต็อก" />
          : activeCut.map(log => (
            <ItemCard key={log.id}>
              <div style={{ display: 'flex', gap: 10, flex: 1, alignItems: 'flex-start' }}>
                <EmojiBox>✂️</EmojiBox>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{log.staffName}</div>
                  <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 1 }}>
                    {log.items?.length || 0} รายการ · {log.timestamp ? toThaiTime(log.timestamp) : ''}
                  </div>
                  {log.items?.slice(0, 3).map((it, i) => (
                    <div key={i} style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>
                      {it.img || ''} {it.itemName} {it.qty} {it.unit}
                    </div>
                  ))}
                  {(log.items?.length || 0) > 3 && (
                    <div style={{ fontSize: 10, color: '#9CA3AF' }}>+{log.items.length - 3} รายการ</div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 15, color: '#FF3B30' }}>
                  {thb(log.totalCost)}
                </span>
                <CancelBtn onClick={() => openCancel({ ...log,
                  _desc: `ตัดสต็อก ${log.items?.length || 0} รายการ ${thb(log.totalCost)}`,
                  _staff: log.staffName }, 'ตัดสต็อก', cancelCutLog)} />
              </div>
            </ItemCard>
          ))
        }
        {/* cancelled cut */}
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
              <ItemCard key={w.id}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{w.img || ''} {w.itemName}</div>
                  <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 2 }}>
                    {toThaiTime(w.timestamp)} · {w.staffName}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#6366F1' }}>{w.qty} {w.unit}</div>
                    {cost > 0 && <div style={{ fontSize: 11, color: '#4338CA', background: '#EEF2FF',
                      borderRadius: 5, padding: '1px 6px', fontWeight: 700 }}>{thb(cost)}</div>}
                  </div>
                  <CancelBtn onClick={() => openCancel({ ...w,
                    _desc: `${w.itemName} ${w.qty} ${w.unit}${cost > 0 ? ` (${thb(cost)})` : ''}`,
                    _staff: w.staffName }, 'ของเสียปิดร้าน', cancelWasteLog)} />
                </div>
              </ItemCard>
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
            <ItemCard key={l.id}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {l.detail?.replace('รับ ', '') || l.itemName || '-'}
                </div>
                <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 2 }}>
                  {toThaiTime(l.timestamp)} · {l.staffName}
                </div>
              </div>
              <CancelBtn onClick={() => openCancel({ ...l,
                _desc: l.detail || 'รับสินค้า',
                _staff: l.staffName }, 'รับสินค้า', cancelAuditEntry)} />
            </ItemCard>
          ))
        }
        {receiveLogs.filter(l => l.cancelled).map(l => (
          <CancelledRow key={l.id} text={l.detail} reason={l.cancelReason} />
        ))}
      </DataSection>

      {/* ═══ Group 5: 🚚 โอนสินค้า ═══ */}
      <DataSection icon="🚚" label="โอนสินค้า" count={transfers.filter(t => t.status !== 'cancelled').length}>
        {transfers.length === 0
          ? <EmptyState />
          : transfers.map(tf => (
            <div key={tf.id} style={{ background: '#fff', borderRadius: 12,
              border: '1px solid #F3F4F6', padding: '11px 14px', marginBottom: 6,
              opacity: tf.cancelled || tf.status === 'cancelled' ? 0.55 : 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13 }}>
                  #{tf.id?.slice(-6) || tf.id}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
              {tf.items?.slice(0, 2).map((it, i) => (
                <div key={i} style={{ fontSize: 10, color: '#9CA3AF' }}>
                  · {it.itemName} {it.qty} {it.unit}
                </div>
              ))}
              {(tf.items?.length || 0) > 2 && (
                <div style={{ fontSize: 10, color: '#9CA3AF' }}>+{tf.items.length - 2} รายการ</div>
              )}
            </div>
          ))
        }
      </DataSection>

      {/* ═══ Group 6: 🔔 แจ้งเติมของ ═══ */}
      <DataSection icon="🔔" label="แจ้งเติมของ" count={dailyRFs.length}>
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
                <ItemCard key={rf.id}>
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
                      {(rf.items || []).map((it, i) => (
                        <span key={i} style={{ fontSize: 10, background: '#F3F4F6',
                          borderRadius: 5, padding: '2px 6px', color: '#374151' }}>
                          {it.img} {it.itemName}{it.qty > 0 ? ` ×${it.qty}` : ''}
                        </span>
                      ))}
                    </div>
                    {/* เหตุผลยกเลิก */}
                    {rf.status === 'cancelled' && rf.cancelReason && (
                      <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 4 }}>
                        เหตุผล: {rf.cancelReason}
                      </div>
                    )}
                  </div>
                </ItemCard>
              )
            })
        }
      </DataSection>

      {/* ═══ Group 7: 📋 Log (accordion — read only) ═══ */}
      <DataSection icon="📋" label="Log" noCount collapsible hint="กดส่วนหัวเพื่อเปิด/ปิด · ลบไม่ได้">
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #F3F4F6', overflow: 'hidden' }}>
          {auditLogs.length === 0
            ? <EmptyState />
            : auditLogs.map(l => <LogRow key={l.id} l={l} />)
          }
        </div>
      </DataSection>

    </div>
  )
}

/* ── Layout helpers ───────────────────────────────────────────────────── */
function DataSection({ icon, label, count, noCount, hint, collapsible, children }) {
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
        {!noCount && count != null && (
          <span style={{ background: count > 0 ? '#FFF1F2' : '#F2F2F7',
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
function getRangeKeys(period) {
  const today = new Date()
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
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
  if (period === '3months') {
    const s = new Date(today.getFullYear(), today.getMonth()-2, 1)
    return { start: fmt(s), end: fmt(today) }
  }
  // default thisWeek
  return getRangeKeys('thisWeek')
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

/* ── WeeklyTab ─────────────────────────────────────────────────────────── */
function WeeklyTab() {
  const [period, setPeriod] = useState('thisWeek')
  const [cutLogs, setCutLogs] = useState([])
  const [wasteLogs, setWasteLogs] = useState([])

  const PILLS = [
    { id: 'thisWeek',  label: 'สัปดาห์นี้' },
    { id: 'lastWeek',  label: 'สัปดาห์ก่อน' },
    { id: 'thisMonth', label: 'เดือนนี้' },
    { id: '3months',   label: '3 เดือน' },
  ]

  const { start, end } = getRangeKeys(period)

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

  const activeCut   = cutLogs.filter(l => !l.cancelled && !l.deletedAt)
  const activeWaste = wasteLogs.filter(l => !l.cancelled)
  const totalCutCost   = activeCut.reduce((s,l) => s+(l.totalCost||0), 0)
  const totalWasteCost = activeWaste.reduce((s,l) => s+(l.totalCost||0), 0)

  // bar chart: daily cost map
  const dayKeys = getDayKeys(start, end).slice(0, 7)
  const dayCostMap = {}
  dayKeys.forEach(k => { dayCostMap[k] = 0 })
  activeCut.forEach(l => { if (dayCostMap[l.date] != null) dayCostMap[l.date] += (l.totalCost||0) })
  const barValues = dayKeys.map(k => dayCostMap[k])
  const maxBar = Math.max(...barValues, 1)

  // top 5 items
  const itemMap = {}
  activeCut.forEach(l => {
    (l.items||[]).forEach(it => {
      const key = it.itemName
      if (!itemMap[key]) itemMap[key] = { name: key, qty: 0, unit: it.unit }
      itemMap[key].qty += (it.qty||0)
    })
  })
  const top5 = Object.values(itemMap).sort((a,b) => b.qty - a.qty).slice(0,5)
  const maxQty = top5[0]?.qty || 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Date range pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {[
          { label: 'ต้นทุนรวม', value: thb(totalCutCost), color: '#FF3B30' },
          { label: 'ครั้งตัด', value: activeCut.length, color: '#1C1C1E' },
          { label: 'ของเสียรวม', value: thb(totalWasteCost), color: '#D97706' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 14, padding: '10px 12px',
            border: '1px solid #F3F4F6', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize: 10, color: '#8E8E93', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 15, color: k.color }}>
              {k.value}
            </div>
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #F3F4F6', padding: '14px 12px' }}>
        <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, marginBottom: 14 }}>
          ต้นทุนรายวัน
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120 }}>
          {dayKeys.map((k, i) => {
            const val = barValues[i]
            const pct = maxBar > 0 ? val / maxBar : 0
            const barH = Math.max(pct * 96, val > 0 ? 4 : 0)
            return (
              <div key={k} style={{ flex: 1, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                {val > 0 && (
                  <div style={{ fontSize: 8, color: '#FF3B30', fontWeight: 700, marginBottom: 2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                    {val >= 1000 ? `${(val/1000).toFixed(1)}K` : val.toFixed(0)}
                  </div>
                )}
                <div style={{ width: '100%', height: barH, background: 'var(--red)',
                  borderRadius: '4px 4px 0 0', minHeight: val > 0 ? 4 : 0,
                  opacity: val > 0 ? 1 : 0 }} />
                <div style={{ fontSize: 10, color: '#8E8E93', marginTop: 4, fontWeight: 700 }}>
                  {dayAbbr(k)}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Top 5 items */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #F3F4F6', padding: '14px 12px' }}>
        <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, marginBottom: 12 }}>
          Top 5 วัตถุดิบที่ใช้มาก
        </div>
        {top5.length === 0 ? <EmptyState /> : top5.map((it, i) => (
          <div key={it.name} style={{ marginBottom: i < top5.length-1 ? 10 : 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{it.name}</span>
              <span style={{ fontSize: 12, color: '#8E8E93' }}>{it.qty.toFixed(2)} {it.unit}</span>
            </div>
            <div style={{ height: 6, background: '#F2F2F7', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: 4, background: 'var(--red)',
                width: `${(it.qty / maxQty) * 100}%`, transition: 'width .4s' }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── WasteAnalysisTab ──────────────────────────────────────────────────── */
function WasteAnalysisTab() {
  const [period, setPeriod] = useState('7days')
  const [wasteLogs, setWasteLogs] = useState([])
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
    const q = query(collection(db, COL.INCOME_RECORDS),
      where('dateKey', '>=', start), where('dateKey', '<=', end))
    return onSnapshot(q, snap => {
      const tot = snap.docs.reduce((s,d) => s+(d.data().total||0), 0)
      setRevenue(tot)
    })
  }, [start, end])

  const active = wasteLogs.filter(l => !l.cancelled)
  const totalWasteCost = active.reduce((s,l) => s+(l.totalCost||0), 0)
  const wastePct = revenue > 0 ? (totalWasteCost / revenue * 100) : 0

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

      {/* KPI */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {[
          { label: 'มูลค่าของเสีย', value: thb(totalWasteCost), color: '#D97706' },
          { label: 'จำนวนครั้ง',    value: active.length,        color: '#1C1C1E' },
          { label: '% ของเสีย',     value: `${wastePct.toFixed(1)}%`, color: wastePct > 5 ? '#DC2626' : '#16A34A' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 14, padding: '10px 12px',
            border: '1px solid #F3F4F6', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize: 10, color: '#8E8E93', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 15, color: k.color }}>
              {k.value}
            </div>
          </div>
        ))}
      </div>

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

/* ── AnalyzeTab ────────────────────────────────────────────────────────── */
function AnalyzeTab() {
  const [pin, setPin]         = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [shake, setShake]     = useState(false)
  const [storedPin, setStoredPin] = useState('1234')
  const [period, setPeriod]   = useState('today')
  const [cutLogs, setCutLogs] = useState([])
  const [revenue, setRevenue] = useState(0)

  const PERIODS = [
    { id: 'today', label: 'วันนี้' },
    { id: '7days', label: '7 วัน' },
    { id: '30days', label: '30 วัน' },
  ]

  // load stored PIN
  useEffect(() => {
    getDoc(doc(db, COL.APP_SETTINGS, 'inventory_settings')).then(snap => {
      if (snap.exists() && snap.data().analyzePin) setStoredPin(snap.data().analyzePin)
    })
  }, [])

  function getAnalyzeRange(p) {
    const today = new Date()
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    const todayKey = fmt(today)
    if (p === 'today') return { start: todayKey, end: todayKey }
    if (p === '7days') { const s = new Date(today); s.setDate(today.getDate()-6); return { start: fmt(s), end: todayKey } }
    if (p === '30days') { const s = new Date(today); s.setDate(today.getDate()-29); return { start: fmt(s), end: todayKey } }
    return { start: todayKey, end: todayKey }
  }

  const { start, end } = getAnalyzeRange(period)

  useEffect(() => {
    if (!unlocked) return
    const q = query(collection(db, COL.CUT_STOCK_LOGS),
      where('date', '>=', start), where('date', '<=', end))
    return onSnapshot(q, snap => setCutLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [unlocked, start, end])

  useEffect(() => {
    if (!unlocked) return
    const q = query(collection(db, COL.INCOME_RECORDS),
      where('dateKey', '>=', start), where('dateKey', '<=', end))
    return onSnapshot(q, snap => {
      setRevenue(snap.docs.reduce((s,d) => s+(d.data().total||0), 0))
    })
  }, [unlocked, start, end])

  function pressKey(k) {
    if (pin.length >= 4) return
    const next = pin + k
    setPin(next)
    if (next.length === 4) {
      if (next === storedPin) {
        setUnlocked(true)
      } else {
        setShake(true)
        setTimeout(() => { setPin(''); setShake(false) }, 600)
      }
    }
  }

  const activeCut   = cutLogs.filter(l => !l.cancelled && !l.deletedAt)
  const totalCutCost   = activeCut.reduce((s,l) => s+(l.totalCost||0), 0)
  const foodCostPct    = revenue > 0 ? (totalCutCost / revenue * 100) : 0
  const grossProfit    = revenue - totalCutCost
  const cutCount       = activeCut.length
  const costPerCut     = cutCount > 0 ? totalCutCost / cutCount : 0

  // top items by cost
  const itemCostMap = {}
  activeCut.forEach(l => {
    (l.items||[]).forEach(it => {
      const k = it.itemName
      if (!itemCostMap[k]) itemCostMap[k] = { name: k, cost: 0 }
      itemCostMap[k].cost += (it.cost || 0)
    })
  })
  const topItems = Object.values(itemCostMap).sort((a,b)=>b.cost-a.cost).slice(0,5)

  /* ── PIN screen ── */
  if (!unlocked) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '32px 0 24px', gap: 20 }}>
        <div style={{ fontSize: 28 }}>🔒</div>
        <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 16, color: '#1C1C1E' }}>
          เข้าสู่หน้าวิเคราะห์
        </div>
        <div style={{ fontSize: 12, color: '#8E8E93' }}>ใส่ PIN 4 หลักของ Owner</div>

        {/* Dot display */}
        <div style={{ display: 'flex', gap: 14, animation: shake ? 'shakePin .5s' : 'none' }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #C7C7CC',
              background: pin.length > i ? 'var(--red)' : 'transparent',
              transition: 'background .15s' }} />
          ))}
        </div>

        {/* Keypad */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 10 }}>
          {[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map((k, i) => (
            <button key={i} onClick={() => {
              if (k === '⌫') { setPin(p => p.slice(0,-1)); return }
              if (k === '') return
              pressKey(String(k))
            }}
              style={{ height: 56, borderRadius: 16, border: '1px solid #E5E5EA',
                background: k === '⌫' ? '#FFF1F2' : '#fff',
                color: k === '⌫' ? '#DC2626' : '#1C1C1E',
                fontSize: k === '⌫' ? 18 : 22, fontWeight: 700, cursor: k === '' ? 'default' : 'pointer',
                boxShadow: '0 1px 3px rgba(0,0,0,0.06)', opacity: k === '' ? 0 : 1 }}>
              {k}
            </button>
          ))}
        </div>

        <style>{`@keyframes shakePin{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}`}</style>
      </div>
    )
  }

  /* ── Unlocked content ── */
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Period pills */}
      <div style={{ display: 'flex', gap: 6 }}>
        {PERIODS.map(p => (
          <button key={p.id} onClick={() => setPeriod(p.id)}
            style={{ border: 'none', borderRadius: 20, padding: '6px 14px', fontSize: 12,
              fontWeight: 700, cursor: 'pointer',
              background: period === p.id ? 'var(--red)' : '#F2F2F7',
              color: period === p.id ? '#fff' : '#6B7280' }}>
            {p.label}
          </button>
        ))}
        <button onClick={() => { setUnlocked(false); setPin('') }}
          style={{ border: 'none', borderRadius: 20, padding: '6px 12px', fontSize: 12,
            fontWeight: 700, cursor: 'pointer', background: '#F2F2F7', color: '#8E8E93',
            marginLeft: 'auto' }}>
          🔒 ล็อก
        </button>
      </div>

      {/* Hero card */}
      <div style={{ borderRadius: 18, padding: '20px 18px',
        background: 'linear-gradient(135deg,#16A34A 0%,#15803D 100%)',
        boxShadow: '0 4px 16px rgba(22,163,74,0.25)' }}>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,.75)', marginBottom: 4 }}>
          Food Cost %
        </div>
        <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 40, color: '#fff',
          lineHeight: 1.1 }}>
          {foodCostPct.toFixed(1)}%
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,.7)', marginTop: 6 }}>
          ต้นทุน {thb(totalCutCost)} / รายได้ {thb(revenue)}
        </div>
      </div>

      {/* 2×2 KPI */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {[
          { label: 'Food Cost จริง',   value: `${foodCostPct.toFixed(1)}%`, color: foodCostPct > 35 ? '#DC2626' : '#16A34A' },
          { label: 'Gross Profit',     value: thb(grossProfit),               color: grossProfit >= 0 ? '#16A34A' : '#DC2626' },
          { label: 'ต้นทุนต่อครั้ง',   value: thb(costPerCut),               color: '#1C1C1E' },
          { label: 'จำนวนตัด',         value: cutCount,                        color: '#1C1C1E' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 14, padding: '12px 14px',
            border: '1px solid #F3F4F6', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize: 11, color: '#8E8E93', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 18, color: k.color }}>
              {k.value}
            </div>
          </div>
        ))}
      </div>

      {/* Top items by cost */}
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #F3F4F6', padding: '14px 12px' }}>
        <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, marginBottom: 12 }}>
          Top วัตถุดิบตามต้นทุน
        </div>
        {topItems.length === 0 ? <EmptyState /> : topItems.map((it, i) => {
          const pct = totalCutCost > 0 ? (it.cost / totalCutCost * 100) : 0
          return (
            <div key={it.name} style={{ marginBottom: i < topItems.length-1 ? 10 : 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{it.name}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#8E8E93' }}>{pct.toFixed(1)}%</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#FF3B30' }}>{thb(it.cost)}</span>
                </div>
              </div>
              <div style={{ height: 6, background: '#F2F2F7', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 4, background: 'var(--red)',
                  width: `${pct}%`, transition: 'width .4s' }} />
              </div>
            </div>
          )
        })}
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
  const [cmCosts,       setCmCosts]       = useState({})

  /* ── cancel sheet state ── */
  const [cancelEntry,  setCancelEntry]  = useState(null)
  const [cancelLabel,  setCancelLabel]  = useState('')
  const [cancelHandler,setCancelHandler]= useState(null)

  /* ── firestore subscriptions ── */
  useEffect(() => {
    const q = query(collection(db, COL.CUT_STOCK_LOGS), where('date', '==', date))
    return onSnapshot(q, snap => setCutLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
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
    return unsub
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
    await updateDoc(doc(db, COL.CUT_STOCK_LOGS, log.id), {
      cancelled: true, cancelReason: reason,
      cancelledBy: window._bizSession?.name || '', cancelledAt: serverTimestamp()
    })
    await addDoc(collection(db, COL.AUDIT_LOGS), {
      action: 'cancel', staffPhone: window._bizSession?.phone || '',
      staffName: window._bizSession?.name || '',
      detail: `ยกเลิกตัดสต็อก ${log.staffName} — เหตุผล: ${reason}`,
      timestamp: serverTimestamp()
    })
  }

  async function cancelWasteLog(log, reason) {
    await updateDoc(doc(db, COL.WASTE_LOGS, log.id), {
      cancelled: true, cancelReason: reason,
      cancelledBy: window._bizSession?.name || '', cancelledAt: serverTimestamp()
    })
    await addDoc(collection(db, COL.AUDIT_LOGS), {
      action: 'cancel_waste', staffPhone: window._bizSession?.phone || '',
      staffName: window._bizSession?.name || '',
      detail: `ยกเลิกของเสีย ${log.itemName} ${log.qty} ${log.unit} — เหตุผล: ${reason}`,
      timestamp: serverTimestamp()
    })
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
    await updateDoc(doc(db, COL.TRANSFER_ORDERS, tf.id), {
      status: 'cancelled', cancelReason: reason,
      cancelledBy: window._bizSession?.name || '', cancelledAt: serverTimestamp()
    })
    await addDoc(collection(db, COL.AUDIT_LOGS), {
      action: 'cancel', staffPhone: window._bizSession?.phone || '',
      staffName: window._bizSession?.name || '',
      detail: `ยกเลิกใบโอน #${tf.id} — เหตุผล: ${reason}`,
      timestamp: serverTimestamp()
    })
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
          {SUB_TABS.map(t => {
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
              style={{ border: 'none', background: '#FFF1F2', color: '#FF3B30', borderRadius: 8,
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
      <div style={{ padding: '0 1rem 100px' }}>
        {subTab === 'daily' && (
          <DailyTab
            cutLogs={cutLogs}
            fruitWaste={fruitWaste}
            closingWaste={closingWaste}
            receiveLogs={receiveLogs}
            transfers={dailyTransfers}
            auditLogs={auditLogs}
            items={reportItems}
            cmCosts={cmCosts}
            openCancel={openCancel}
            cancelCutLog={cancelCutLog}
            cancelWasteLog={cancelWasteLog}
            cancelAuditEntry={cancelAuditEntry}
            cancelTransfer={cancelTransfer}
            dailyRFs={dailyRFs}
          />
        )}
        {subTab === 'weekly'  && <WeeklyTab />}
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
