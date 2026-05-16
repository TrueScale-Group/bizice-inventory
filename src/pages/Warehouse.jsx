import { useState, useEffect } from 'react'
import { db } from '../firebase'
import {
  collection, query, where, onSnapshot, doc,
  updateDoc, addDoc, serverTimestamp, writeBatch, deleteDoc
} from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { sortLotsFIFO, getExpStatus, formatDateDDMMYY } from '../utils/fifo'
import { COL } from '../constants/collections'

const CATS = [
  { id: 'all',        name: 'ทั้งหมด',    emoji: '🔍' },
  { id: 'แยม',       name: 'แยม',        emoji: '🍓' },
  { id: 'ผลไม้',     name: 'ผลไม้',      emoji: '🍋' },
  { id: 'ไซรัป',     name: 'ไซรัป',      emoji: '🍯' },
  { id: 'ท็อปปิ้ง',  name: 'ท็อปปิ้ง',   emoji: '💎' },
  { id: 'วัตถุดิบ',  name: 'วัตถุดิบ',   emoji: '🥛' },
  { id: 'บรรจุภัณฑ์', name: 'บรรจุ',     emoji: '🥤' },
  { id: 'อื่นๆ',     name: 'อื่นๆ',      emoji: '🔖' },
]

// Warehouse color palette (index-based)
const WH_COLORS = ['#34C759', '#FF9500', '#007AFF', '#AF52DE', '#FF2D55']
const WH_BG     = ['#DCFCE7', '#FEF3C7', '#DBEAFE', '#F3E8FF', '#FFE4E6']

export default function Warehouse() {
  const [scope, setScope]         = useState('')
  const [cat, setCat]             = useState('all')
  const [search, setSearch]       = useState('')
  const [warehouses, setWarehouses] = useState([])
  const [items, setItems]         = useState([])
  const [balances, setBalances]   = useState([])
  const [lots, setLots]           = useState([])
  const [lotItem, setLotItem]     = useState(null)
  const [hoverItem, setHoverItem] = useState(null)
  const [expThresholds, setExpThresholds] = useState({ yellow: 30, red: 7 })

  const session = window._bizSession || {}

  useEffect(() => {
    const unsub = onSnapshot(doc(db, COL.APP_SETTINGS, 'exp_thresholds'), snap => {
      if (snap.exists()) setExpThresholds(snap.data())
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    const u1 = onSnapshot(collection(db, COL.WAREHOUSES), snap => {
      const wList = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(w => w.active !== false)
      setWarehouses(wList)
      if (wList.length > 0) {
        // Default: สาขา (type==='shop' หรือ isShop===true) → fallback อันที่ 2 → อันแรก
        const shop = wList.find(w => w.type === 'shop' || w.isShop === true)
          || wList.find((_, i) => i > 0)
          || wList[0]
        setScope(prev => prev || shop.id)
      }
    })
    const u2 = onSnapshot(collection(db, COL.ITEMS), snap => {
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => { u1(); u2() }
  }, [])

  useEffect(() => {
    const q = !scope
      ? query(collection(db, COL.STOCK_BALANCES))
      : query(collection(db, COL.STOCK_BALANCES), where('warehouseId', '==', scope))
    const unsub = onSnapshot(q, snap => {
      setBalances(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [scope])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, COL.LOT_TRACKING), snap => {
      setLots(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  function getStatus(qty, item) {
    if (!item) return 'ok'
    if (qty <= 0) return 'out'
    if (qty <= item.minQty) return 'low'
    return 'ok'
  }

  function getPct(qty, item) {
    if (!item || !item.maxQty) return 0
    return Math.min(100, Math.round((qty / item.maxQty) * 100))
  }

  // กรอง LOT ที่ถูก split ออกแล้ว (แสดงแค่ sub-lots ที่ active)
  function getItemLots(itemId) {
    return sortLotsFIFO(lots.filter(l => l.itemId === itemId && l.status !== 'split'))
  }

  const EXP_ORDER = { expired: 0, danger: 1, warning: 2, ok: 3 }

  const rows = items
    .filter(i => cat === 'all' || i.category === cat)
    .filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()))
    .map(item => {
      const bal = balances.filter(b => b.itemId === item.id)
      const qty = bal.reduce((s, b) => s + (b.qty || 0), 0)
      const itemLots = getItemLots(item.id)
      const warnLots = itemLots.filter(l => getExpStatus(l.expDate || '', expThresholds).status !== 'ok')
      // หา worst EXP status ในทุก lot ของ item นี้
      let worstExp = null
      for (const lot of itemLots) {
        const exp = getExpStatus(lot.expDate || '', expThresholds)
        if (!worstExp || EXP_ORDER[exp.status] < EXP_ORDER[worstExp.status]) worstExp = exp
      }
      return { item, qty, itemLots, warnLots, worstExp, status: getStatus(qty, item), pct: getPct(qty, item) }
    })

  function openLotPopup(item, itemLots, warnLots, qty) {
    setLotItem({ item, itemLots, warnLots, qty, expThresholds, warehouses, session })
  }

  return (
    <div className="page-pad">
      {/* Sub-header */}
      <div className="page-subbar">
        <span className="subbar-title">คลังสินค้า</span>
      </div>

      {/* Scope selector */}
      <div style={{ padding: '0 1rem' }}>
        <div className="segment">
          {warehouses.map(w => (
            <button key={w.id} className={`seg-btn${scope === w.id ? ' active' : ''}`} onClick={() => setScope(w.id)}>
              {w.name}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: '0 1rem', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="search-wrap" style={{ margin: 0, flex: '0 0 55%' }}>
          <span className="search-icon">🔍</span>
          <input className="search-input" placeholder="ค้นหา..." value={search}
            onChange={e => setSearch(e.target.value)} />
          {search && (
            <button onClick={() => setSearch('')}
              style={{ border: 'none', background: 'none', color: '#8E8E93', fontSize: 15, cursor: 'pointer', padding: '0 8px' }}>✕</button>
          )}
        </div>
        <span style={{ fontSize: 12, color: 'var(--txt3)' }}>
          {rows.length} รายการ
        </span>
      </div>

      {/* Sidebar + Stock grid */}
      <div style={{ display: 'flex', gap: 0, margin: '0 1rem', borderRadius: 14,
        border: '1px solid var(--border)', overflow: 'hidden', background: 'var(--surf)' }}>

        {/* Left: category sidebar */}
        <div style={{ width: 68, flexShrink: 0, overflowY: 'auto', background: 'var(--bg)',
          borderRight: '1px solid var(--border)' }}>
          {CATS.map(c => {
            const active = cat === c.id
            return (
              <button key={c.id} onClick={() => setCat(c.id)}
                style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '10px 4px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                  background: active ? 'var(--surf)' : 'transparent',
                  borderLeft: active ? '3px solid var(--red)' : '3px solid transparent',
                  transition: 'all .15s' }}>
                <span style={{ fontSize: 18, lineHeight: 1 }}>{c.emoji}</span>
                <span style={{ fontSize: 9.5, fontWeight: active ? 700 : 500, lineHeight: 1.2,
                  color: active ? 'var(--red)' : 'var(--txt3)', textAlign: 'center', wordBreak: 'break-word', maxWidth: 60 }}>
                  {c.name}
                </span>
              </button>
            )
          })}
        </div>

        {/* Right: 2-col stock cards */}
        <div style={{ flex: 1, overflowY: 'auto', maxHeight: 'calc(100vh - 260px)' }}>
          {rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--txt3)' }}>ไม่มีข้อมูล</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: 10 }}>
              {rows.map(({ item, qty, itemLots, warnLots, worstExp, status, pct }) => (
                <div key={item.id} className="stock-card" onClick={() => setHoverItem(hoverItem === item.id ? null : item.id)}
                  style={{ cursor: 'pointer', position: 'relative' }}>
                  <div style={{ position: 'absolute', top: 6, right: 6,
                    width: 18, height: 18, borderRadius: '50%',
                    background: hoverItem === item.id ? 'var(--red)' : '#E5E5EA',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, color: hoverItem === item.id ? '#fff' : '#8E8E93',
                    fontWeight: 700, transition: 'all .15s', flexShrink: 0 }}>
                    {hoverItem === item.id ? '✕' : 'ⓘ'}
                  </div>
                  <div className="stock-emoji">{item.img || '📦'}</div>
                  <div className="stock-name">{item.name}</div>
                  <div className="stock-cat">{item.category}</div>
                  <div>
                    <span className={`stock-qty ${status}`}>{qty}</span>
                    <span className="stock-unit"> {item.unitUse}</span>
                  </div>
                  <div className="progress-bar">
                    <div className={`progress-fill ${status}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                    <span className={`badge badge-${status === 'ok' ? 'ok' : status === 'low' ? 'low' : 'out'}`}>
                      {status === 'ok' ? '✅ ปกติ' : status === 'low' ? '⚠️ ใกล้หมด' : '❌ หมด'}
                    </span>
                    {itemLots.length > 0 && (() => {
                      // สี pill ตาม worst EXP
                      const ws = worstExp?.status
                      const noExp = !worstExp || worstExp.days === 999
                      const pillStyle = noExp
                        ? { bg: '#F3F4F6', color: '#6B7280', border: '#E5E7EB' }
                        : ws === 'ok'
                        ? { bg: '#DCFCE7', color: '#16A34A', border: '#86EFAC' }
                        : ws === 'warning'
                        ? { bg: '#FEF3C7', color: '#B45309', border: '#FDE68A' }
                        : { bg: '#FEE2E2', color: '#DC2626', border: '#FECACA' }
                      const expText = noExp ? 'ไม่ระบุ EXP' : worstExp.label
                      return (
                        <button
                          onClick={e => { e.stopPropagation(); openLotPopup(item, itemLots, warnLots, qty) }}
                          style={{
                            border: `1.5px solid ${pillStyle.border}`,
                            background: pillStyle.bg,
                            color: pillStyle.color,
                            borderRadius: 8,
                            padding: '3px 7px',
                            fontSize: 10,
                            fontWeight: 700,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 3,
                            whiteSpace: 'nowrap',
                            lineHeight: 1.4,
                            fontFamily: 'Prompt, sans-serif',
                          }}>
                          📦 {itemLots.length} · {expText}
                        </button>
                      )
                    })()}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--txt3)' }}>ตัด: {item.unitUse}</div>

                  {/* Unit info tooltip */}
                  {hoverItem === item.id && (
                    <div style={{ marginTop: 8, padding: '10px 12px', background: '#1C1C1E', borderRadius: 12, fontSize: 11, color: '#fff' }}>
                      <div style={{ fontSize: 10, color: '#8E8E93', fontWeight: 700, marginBottom: 8 }}>
                        {item.img || '📦'} หน่วยบรรจุ
                      </div>
                      {item.unitBuy && item.unitUse && item.convBuyToUse ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: item.unitSub ? 6 : 0, flexWrap: 'wrap' }}>
                          <span style={{ background: '#3A3A3C', borderRadius: 6, padding: '3px 8px', fontWeight: 700 }}>1 {item.unitBuy}</span>
                          <span style={{ color: '#8E8E93' }}>→</span>
                          <span style={{ background: '#3A3A3C', borderRadius: 6, padding: '3px 8px', fontWeight: 700 }}>{item.convBuyToUse} {item.unitUse}</span>
                        </div>
                      ) : null}
                      {item.unitUse && item.unitSub && item.convUseToSub ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ background: '#3A3A3C', borderRadius: 6, padding: '3px 8px', fontWeight: 700 }}>1 {item.unitUse}</span>
                          <span style={{ color: '#8E8E93' }}>→</span>
                          <span style={{ background: '#3A3A3C', borderRadius: 6, padding: '3px 8px', fontWeight: 700 }}>{item.convUseToSub} {item.unitSub}</span>
                        </div>
                      ) : null}
                      {!item.convBuyToUse && !item.convUseToSub && (
                        <div style={{ color: '#636366' }}>ไม่มีข้อมูลหน่วย</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* LOT Popup */}
      {lotItem && <LotPopup data={lotItem} onClose={() => setLotItem(null)} />}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   LotPopup — แสดง + แก้ไข + แบ่ง LOT
───────────────────────────────────────────────────────────── */
function LotPopup({ data, onClose }) {
  const { item, itemLots: initLots, warnLots, qty, expThresholds,
          warehouses = [], session = {} } = data
  const thr = expThresholds || { yellow: 30, red: 7 }
  const role    = session.role || 'viewer'
  const canEdit = role === 'editor' || role === 'owner'

  // Local lots state — อัปเดต optimistic หลังแก้ไข / split
  const [lots, setLots]       = useState(() => initLots)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState({})
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitDraft, setSplitDraft] = useState({})
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [closeConfirm, setCloseConfirm] = useState(false) // X กด 2 ครั้งเมื่อมีข้อมูลค้าง

  // Sync เมื่อ parent snapshot เปลี่ยน
  useEffect(() => { setLots(initLots) }, [initLots])

  // ── Warehouse helpers ──────────────────────────────────────
  function whIndex(warehouseId) {
    return warehouses.findIndex(w => w.id === warehouseId)
  }
  function whColor(warehouseId) {
    const i = whIndex(warehouseId)
    return i < 0 ? '#8E8E93' : WH_COLORS[i % WH_COLORS.length]
  }
  function whBg(warehouseId) {
    const i = whIndex(warehouseId)
    return i < 0 ? '#F3F4F6' : WH_BG[i % WH_BG.length]
  }
  function whName(warehouseId) {
    if (warehouseId === '__shop__') return 'ร้าน/ส่ง'
    return warehouses.find(w => w.id === warehouseId)?.name || warehouseId || 'ไม่ระบุ'
  }

  // ── LOT data helpers ──────────────────────────────────────
  function getLotDisplay(lot) {
    return lot.lotNo || formatDateDDMMYY(lot.receiveDate) || 'Start'
  }

  /** qty รวมของ lot นี้ (รับมาทั้งหมด) */
  function getLotQty(lot) {
    if (lot.qty != null) return lot.qty
    if (lot.locationQty) return Object.values(lot.locationQty).reduce((s, v) => s + v, 0)
    return (lot.inWarehouse || 0) + (lot.inShop || 0) + (lot.used || 0)
  }

  /**
   * locationQty map → { warehouseId: qty }
   * Fallback จาก legacy inWarehouse / inShop fields
   */
  function getLocationBreakdown(lot) {
    if (lot.locationQty && Object.keys(lot.locationQty).length > 0) {
      return lot.locationQty
    }
    const bd = {}
    const whId = lot.warehouseId || '__main__'
    if ((lot.inWarehouse || 0) > 0) bd[whId] = lot.inWarehouse
    if ((lot.inShop || 0) > 0)      bd['__shop__'] = lot.inShop
    // ถ้าไม่มี field ใดเลย → ถือว่า qty ทั้งหมดยังอยู่ที่ warehouseId เดิม (ยังไม่ได้ใช้)
    if (Object.keys(bd).length === 0 && (lot.qty || 0) > 0 && whId) {
      bd[whId] = lot.qty
    }
    return bd
  }

  /** qty ที่ใช้ไปแล้ว = รับมา - ยังคงเหลืออยู่ทุกคลัง */
  function getUsed(lot) {
    const total  = getLotQty(lot)
    const active = Object.values(getLocationBreakdown(lot)).reduce((s, v) => s + v, 0)
    return Math.max(0, total - active)
  }

  // ── Edit handlers ─────────────────────────────────────────
  function startEdit(lot) {
    setEditingId(lot.id)
    setEditDraft({
      lotNo:       lot.lotNo || '',
      receiveDate: lot.receiveDate || '',
      mfgDate:     lot.mfgDate || '',
      expDate:     lot.expDate || '',
      supplier:    lot.supplier || '',
    })
    setSplitOpen(false)
    setSplitDraft({})
    setError('')
  }

  function cancelEdit() {
    setEditingId(null)
    setEditDraft({})
    setSplitOpen(false)
    setSplitDraft({})
    setError('')
  }

  async function saveEdit(lot) {
    setSaving(true); setError('')
    try {
      const updates = {
        lotNo:       editDraft.lotNo.trim() || 'Start',
        receiveDate: editDraft.receiveDate || '',
        mfgDate:     editDraft.mfgDate || '',
        expDate:     editDraft.expDate || '',
        supplier:    editDraft.supplier.trim() || '',
        isStartLot:  !editDraft.lotNo.trim() || editDraft.lotNo.trim() === 'Start',
        updatedAt:   serverTimestamp(),
        updatedBy:   session.name || 'unknown',
      }
      await updateDoc(doc(db, COL.LOT_TRACKING, lot.id), updates)
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action:   'lot_edit',
        lotId:    lot.id,
        itemId:   item.id,
        itemName: item.name,
        before: {
          lotNo: lot.lotNo, receiveDate: lot.receiveDate,
          mfgDate: lot.mfgDate, expDate: lot.expDate, supplier: lot.supplier,
        },
        after:  updates,
        by: session.name || 'unknown',
        at: serverTimestamp(),
      })
      setLots(prev => prev.map(l => l.id === lot.id ? { ...l, ...updates } : l))
      setEditingId(null)
    } catch (e) {
      setError('บันทึกไม่สำเร็จ: ' + e.message)
    }
    setSaving(false)
  }

  // ── Split handlers ────────────────────────────────────────
  function openSplit(lot) {
    const total   = getLotQty(lot)
    const halfA   = Math.floor(total / 2)
    const base    = (editDraft.lotNo?.trim() || lot.lotNo || 'Start').replace(/-[AB]$/, '')
    setSplitDraft({
      lotNoA: base + '-A', qtyA: String(halfA),
      mfgA:   editDraft.mfgDate || lot.mfgDate || '',
      expA:   editDraft.expDate || lot.expDate || '',
      lotNoB: base + '-B', qtyB: String(total - halfA),
      mfgB:   '',
      expB:   '',
    })
    setSplitOpen(true)
    setError('')
  }

  async function confirmSplit(lot) {
    const total = getLotQty(lot)
    const qtyA  = Number(splitDraft.qtyA) || 0
    const qtyB  = Number(splitDraft.qtyB) || 0
    if (qtyA <= 0 || qtyB <= 0) { setError('จำนวนแต่ละ sub-lot ต้องมากกว่า 0'); return }
    if (qtyA + qtyB !== total)  { setError(`จำนวนรวมต้องเท่ากับ ${total} ${item.unitUse} (ปัจจุบัน: ${qtyA + qtyB})`); return }

    setSaving(true); setError('')
    try {
      const batch   = writeBatch(db)
      const now     = serverTimestamp()
      const bd      = getLocationBreakdown(lot)
      const firstWh = Object.keys(bd)[0] || lot.warehouseId || ''

      // สร้าง sub-lot A
      const refA = doc(collection(db, COL.LOT_TRACKING))
      batch.set(refA, {
        itemId:       item.id,
        warehouseId:  firstWh,
        lotNo:        splitDraft.lotNoA || lot.lotNo + '-A',
        qty:          qtyA,
        locationQty:  { [firstWh]: qtyA },
        mfgDate:      splitDraft.mfgA || '',
        expDate:      splitDraft.expA || '',
        receiveDate:  lot.receiveDate || '',
        supplier:     lot.supplier || '',
        parentLotId:  lot.id,
        subLotSuffix: 'A',
        isStartLot:   false,
        status:       'active',
        source:       lot.source || '',
        isOpening:    lot.isOpening || false,
        createdAt:    now,
        createdBy:    session.name || 'unknown',
      })

      // สร้าง sub-lot B
      const refB = doc(collection(db, COL.LOT_TRACKING))
      batch.set(refB, {
        itemId:       item.id,
        warehouseId:  firstWh,
        lotNo:        splitDraft.lotNoB || lot.lotNo + '-B',
        qty:          qtyB,
        locationQty:  { [firstWh]: qtyB },
        mfgDate:      splitDraft.mfgB || '',
        expDate:      splitDraft.expB || '',
        receiveDate:  lot.receiveDate || '',
        supplier:     lot.supplier || '',
        parentLotId:  lot.id,
        subLotSuffix: 'B',
        isStartLot:   false,
        status:       'active',
        source:       lot.source || '',
        isOpening:    lot.isOpening || false,
        createdAt:    now,
        createdBy:    session.name || 'unknown',
      })

      // Mark parent ว่า split แล้ว
      batch.update(doc(db, COL.LOT_TRACKING, lot.id), {
        status:    'split',
        splitInto: [refA.id, refB.id],
        updatedAt: now,
        updatedBy: session.name || 'unknown',
      })

      // Audit log
      const auditRef = doc(collection(db, COL.AUDIT_LOGS))
      batch.set(auditRef, {
        action:    'lot_split',
        lotId:     lot.id,
        itemId:    item.id,
        itemName:  item.name,
        splitInto: [refA.id, refB.id],
        qtyA, qtyB,
        lotNoA:    splitDraft.lotNoA,
        lotNoB:    splitDraft.lotNoB,
        by:  session.name || 'unknown',
        at:  now,
      })

      await batch.commit()

      // Optimistic update — ลบ parent เพิ่ม A/B
      setLots(prev => [
        ...prev.filter(l => l.id !== lot.id),
        {
          id: refA.id, itemId: item.id, warehouseId: firstWh,
          lotNo: splitDraft.lotNoA, qty: qtyA, locationQty: { [firstWh]: qtyA },
          mfgDate: splitDraft.mfgA, expDate: splitDraft.expA,
          receiveDate: lot.receiveDate, supplier: lot.supplier,
          parentLotId: lot.id, subLotSuffix: 'A', status: 'active',
        },
        {
          id: refB.id, itemId: item.id, warehouseId: firstWh,
          lotNo: splitDraft.lotNoB, qty: qtyB, locationQty: { [firstWh]: qtyB },
          mfgDate: splitDraft.mfgB, expDate: splitDraft.expB,
          receiveDate: lot.receiveDate, supplier: lot.supplier,
          parentLotId: lot.id, subLotSuffix: 'B', status: 'active',
        },
      ])
      setEditingId(null)
      setSplitOpen(false)
    } catch (e) {
      setError('แบ่ง LOT ไม่สำเร็จ: ' + e.message)
    }
    setSaving(false)
  }

  // ── Delete LOT (Owner only) ───────────────────────────────
  async function handleDelete(lot) {
    setSaving(true); setError('')
    try {
      await deleteDoc(doc(db, COL.LOT_TRACKING, lot.id))
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action:   'lot_delete',
        lotId:    lot.id,
        itemId:   item.id,
        itemName: item.name,
        lotNo:    lot.lotNo || '-',
        qty:      lot.qty || 0,
        by:  session.name || 'unknown',
        at:  serverTimestamp(),
      })
      setLots(prev => prev.filter(l => l.id !== lot.id))
      setConfirmDeleteId(null)
      setEditingId(null)
    } catch (e) {
      setError('ลบไม่สำเร็จ: ' + e.message)
    }
    setSaving(false)
  }

  // ── EXP Legend ───────────────────────────────────────────
  const expLegend = [
    { color: '#1A7F37', bg: '#DCFCE7', label: `> ${thr.yellow} วัน` },
    { color: '#92600A', bg: '#FEF3C7', label: `${thr.red + 1}–${thr.yellow} วัน` },
    { color: '#FF3B30', bg: '#FEE2E2', label: `≤ ${thr.red} วัน / หมด` },
  ]

  const sortedLots = sortLotsFIFO(lots)

  return (
    <div className="modal-backdrop"
      onClick={e => { e.stopPropagation(); e.preventDefault() }}
      onTouchStart={e => { e.stopPropagation(); e.preventDefault() }}
      onTouchEnd={e => { e.stopPropagation(); e.preventDefault() }}
      onPointerDown={e => { e.stopPropagation(); e.preventDefault() }}>
      <div className="bottom-sheet" onClick={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-header">
          <div>
            <div style={{ fontSize: 20 }}>
              {item.img} <span style={{ fontFamily: 'Prompt', fontWeight: 700 }}>{item.name}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
              ตัด: {item.unitUse} · {item.unitConversion}
            </div>
          </div>

          {/* X button — กด 2 ครั้งเมื่อมีข้อมูลค้างอยู่ */}
          {closeConfirm ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <button
                onClick={onClose}
                style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid #DC2626',
                  background: '#FEE2E2', color: '#DC2626', fontSize: 15, fontWeight: 800,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                ✕
              </button>
              <span style={{ fontSize: 9, color: '#DC2626', fontWeight: 700, whiteSpace: 'nowrap' }}>
                กดอีกครั้ง
              </span>
            </div>
          ) : (
            <button
              className="sheet-close"
              onClick={() => {
                // ถ้ากำลังแก้ข้อมูลอยู่ → ต้องกด 2 ครั้ง
                if (editingId || confirmDeleteId) {
                  setCloseConfirm(true)
                  // auto-reset หลัง 3 วินาที ถ้าไม่กดซ้ำ
                  setTimeout(() => setCloseConfirm(false), 3000)
                } else {
                  onClose()
                }
              }}>
              ✕
            </button>
          )}
        </div>

        <div className="sheet-body">
          {/* ── Info box ─────────────────────────────────── */}
          <div style={{ background: '#EFF6FF', borderRadius: 10, padding: 12, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: 'var(--txt2)' }}>Stock คงเหลือ</span>
              <span style={{ fontWeight: 700, fontFamily: 'Prompt' }}>{qty} {item.unitUse}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: 'var(--txt2)' }}>จำนวน Lot</span>
              <span style={{ fontWeight: 700 }}>{sortedLots.length} Lot</span>
            </div>
            {warnLots.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: '#D97706' }}>Lot ใกล้หมดอายุ</span>
                <span style={{ fontWeight: 700, color: '#D97706' }}>{warnLots.length} Lot ⚠️</span>
              </div>
            )}
            {/* EXP Legend */}
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #DBEAFE',
              display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {expLegend.map(l => (
                <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 4,
                  background: l.bg, borderRadius: 6, padding: '2px 8px' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: l.color }} />
                  <span style={{ fontSize: 10, color: l.color, fontWeight: 700 }}>{l.label}</span>
                </div>
              ))}
            </div>
            {/* Location color legend */}
            {warehouses.length > 0 && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #DBEAFE',
                display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {warehouses.map((wh, i) => (
                  <div key={wh.id} style={{ display: 'flex', alignItems: 'center', gap: 4,
                    background: WH_BG[i % WH_BG.length], borderRadius: 6, padding: '2px 8px' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: WH_COLORS[i % WH_COLORS.length] }} />
                    <span style={{ fontSize: 10, color: WH_COLORS[i % WH_COLORS.length], fontWeight: 700 }}>{wh.name}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4,
                  background: '#F3F4F6', borderRadius: 6, padding: '2px 8px' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#9CA3AF' }} />
                  <span style={{ fontSize: 10, color: '#6B7280', fontWeight: 700 }}>ใช้แล้ว</span>
                </div>
              </div>
            )}
          </div>

          {/* ── LOT Cards ────────────────────────────────── */}
          {error && (
            <div style={{ background: '#FEE2E2', color: '#DC2626', borderRadius: 10,
              padding: '10px 14px', marginBottom: 12, fontSize: 13, fontWeight: 600 }}>
              ⚠️ {error}
            </div>
          )}

          {sortedLots.map((lot, idx) => {
            const isEditing = editingId === lot.id
            const exp       = getExpStatus(lot.expDate || '', thr)
            const bd        = getLocationBreakdown(lot)
            const usedQty   = getUsed(lot)
            const totalQty  = getLotQty(lot)
            const lotDisplay = getLotDisplay(lot)

            const cardBg = exp.status === 'expired' || exp.status === 'danger' ? '#FFF5F5'
                         : exp.status === 'warning' ? '#FFFBEB'
                         : isEditing ? '#F0FDF4'
                         : 'var(--bg)'
            const cardBorder = exp.status === 'expired' || exp.status === 'danger' ? '1px solid #FECACA'
                             : exp.status === 'warning' ? '1px solid #FDE68A'
                             : isEditing ? '1px solid #86EFAC'
                             : '1px solid var(--border)'

            return (
              <div key={lot.id} style={{ marginBottom: 14, background: cardBg,
                borderRadius: 12, padding: 12, border: cardBorder, transition: 'all .2s' }}>

                {/* ── Card Header ─────────────────────── */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14 }}>
                      LOT {lotDisplay}
                    </span>
                    {/* FIFO badge */}
                    {idx === 0 && (
                      <span style={{ background: '#DCFCE7', color: '#166534', fontSize: 9, fontWeight: 700,
                        padding: '2px 6px', borderRadius: 6 }}>FIFO ออกก่อน</span>
                    )}
                    {/* Opening Stock badge */}
                    {lot.isStartLot && (
                      <span style={{ background: '#F3F4F6', color: '#6B7280', fontSize: 9, fontWeight: 700,
                        padding: '2px 6px', borderRadius: 6 }}>📋 Opening Stock</span>
                    )}
                    {/* Sub-lot badge */}
                    {lot.parentLotId && (
                      <span style={{ background: '#EDE9FE', color: '#7C3AED', fontSize: 9, fontWeight: 700,
                        padding: '2px 6px', borderRadius: 6 }}>✂️ Sub-lot {lot.subLotSuffix || ''}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14 }}>
                      {totalQty} {item.unitUse}
                    </span>
                    {canEdit && !isEditing && (
                      <button onClick={() => startEdit(lot)}
                        style={{ border: 'none', background: '#EFF6FF', borderRadius: 8,
                          padding: '4px 10px', fontSize: 12, color: '#2563EB',
                          cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        ✏️ แก้ไข
                      </button>
                    )}
                  </div>
                </div>

                {/* ── Dates row ───────────────────────── */}
                {!isEditing && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 4 }}>
                      MFG {formatDateDDMMYY(lot.mfgDate)} › EXP {formatDateDDMMYY(lot.expDate)}
                      {' · '}
                      <span style={{ color: exp.color, fontWeight: 700 }}>{exp.label}</span>
                    </div>
                    {lot.receiveDate && (
                      <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 4 }}>
                        รับ: {formatDateDDMMYY(lot.receiveDate)}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 8 }}>
                      ผู้จำหน่าย: {lot.supplier || '-'}
                    </div>
                  </>
                )}

                {/* ── Location breakdown chips ────────── */}
                {!isEditing && (
                  <LocationChips
                    bd={bd} usedQty={usedQty} totalQty={totalQty}
                    unitUse={item.unitUse}
                    whName={whName} whColor={whColor} whBg={whBg}
                  />
                )}

                {/* ── Edit Form ────────────────────────── */}
                {isEditing && !splitOpen && confirmDeleteId !== lot.id && (
                  <EditForm
                    draft={editDraft}
                    setDraft={setEditDraft}
                    lot={lot}
                    totalQty={totalQty}
                    saving={saving}
                    isOwner={role === 'owner'}
                    onCancel={cancelEdit}
                    onSave={() => saveEdit(lot)}
                    onSplit={() => openSplit(lot)}
                    onDelete={() => setConfirmDeleteId(lot.id)}
                  />
                )}

                {/* ── Confirm Delete ───────────────────── */}
                {isEditing && confirmDeleteId === lot.id && (
                  <div style={{ borderTop: '1px solid #FECACA', marginTop: 10, paddingTop: 12 }}>
                    <div style={{ background: '#FEF2F2', borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#DC2626', marginBottom: 4 }}>
                        🗑️ ยืนยันลบ LOT นี้?
                      </div>
                      <div style={{ fontSize: 12, color: '#7F1D1D' }}>
                        <strong>LOT {getLotDisplay(lot)}</strong> · {totalQty} {item.unitUse}
                      </div>
                      <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
                        การลบจะบันทึกใน Audit Log และไม่สามารถกู้คืนได้
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => setConfirmDeleteId(null)} disabled={saving}
                        style={{ flex: 1, border: '1.5px solid var(--border)', borderRadius: 10,
                          padding: '9px 0', fontSize: 13, background: 'var(--bg)',
                          color: 'var(--txt2)', cursor: 'pointer', fontWeight: 600 }}>
                        ยกเลิก
                      </button>
                      <button onClick={() => handleDelete(lot)} disabled={saving}
                        style={{ flex: 1, border: 'none', borderRadius: 10,
                          padding: '9px 0', fontSize: 13, background: '#DC2626',
                          color: '#fff', cursor: 'pointer', fontWeight: 700,
                          opacity: saving ? 0.6 : 1 }}>
                        {saving ? '⏳...' : '🗑️ ลบ LOT'}
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Split Form ───────────────────────── */}
                {isEditing && splitOpen && (
                  <SplitForm
                    draft={splitDraft}
                    setDraft={setSplitDraft}
                    totalQty={totalQty}
                    unitUse={item.unitUse}
                    saving={saving}
                    onCancel={() => setSplitOpen(false)}
                    onConfirm={() => confirmSplit(lot)}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ── Location Chips Component ────────────────────────────────── */
function LocationChips({ bd, usedQty, totalQty, unitUse, whName, whColor, whBg }) {
  const locations = Object.entries(bd).filter(([, q]) => q > 0)
  if (locations.length === 0 && usedQty === 0) return null

  // scale dots: max 24 total
  const maxDots = 24
  const scale   = totalQty > maxDots ? maxDots / totalQty : 1

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, color: 'var(--txt2)', marginBottom: 5,
        fontWeight: 700, textTransform: 'uppercase', letterSpacing: .5 }}>
        STOCK {unitUse}:
      </div>

      {/* Dot bar */}
      <div className="piece-chips" style={{ marginBottom: 8 }}>
        {locations.map(([whId, qty]) => {
          const dots = Math.max(1, Math.round(qty * scale))
          const color = whColor(whId)
          return Array.from({ length: dots }).map((_, i) => (
            <div key={`${whId}-${i}`}
              style={{ width: 10, height: 10, borderRadius: '50%',
                background: color, flexShrink: 0,
                boxShadow: `0 0 0 1.5px ${color}33` }} />
          ))
        })}
        {usedQty > 0 && Array.from({ length: Math.max(1, Math.round(usedQty * scale)) }).map((_, i) => (
          <div key={`used-${i}`}
            style={{ width: 10, height: 10, borderRadius: '50%',
              background: '#E5E7EB', flexShrink: 0,
              border: '1.5px solid #D1D5DB' }} />
        ))}
      </div>

      {/* Legend row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {locations.map(([whId, qty]) => (
          <div key={whId} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: whColor(whId) }} />
            <span style={{ fontSize: 10, color: 'var(--txt2)', fontWeight: 600 }}>
              {whName(whId)} ({qty})
            </span>
          </div>
        ))}
        {usedQty > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#9CA3AF' }} />
            <span style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>ใช้แล้ว ({usedQty})</span>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Edit Form Component ─────────────────────────────────────── */
function EditForm({ draft, setDraft, lot, totalQty, saving, isOwner, onCancel, onSave, onSplit, onDelete }) {
  const field = (label, key, type = 'text') => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <input
        type={type}
        value={draft[key] || ''}
        onChange={e => setDraft(f => ({ ...f, [key]: e.target.value }))}
        style={{ width: '100%', border: '1.5px solid var(--border)', borderRadius: 8,
          padding: '8px 12px', fontSize: 14, background: 'var(--bg)',
          color: 'var(--txt1)', boxSizing: 'border-box', outline: 'none',
          fontFamily: 'Prompt, sans-serif' }}
      />
    </div>
  )

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#16A34A', marginBottom: 12 }}>✏️ แก้ไขข้อมูล LOT</div>
      {field('Lot No.', 'lotNo')}
      {field('วันที่รับสินค้า', 'receiveDate', 'date')}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600, marginBottom: 4 }}>MFG (ผลิต)</div>
          <input type="date" value={draft.mfgDate || ''}
            onChange={e => setDraft(f => ({ ...f, mfgDate: e.target.value }))}
            style={{ width: '100%', border: '1.5px solid var(--border)', borderRadius: 8,
              padding: '8px 10px', fontSize: 13, background: 'var(--bg)',
              color: 'var(--txt1)', boxSizing: 'border-box', outline: 'none' }} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600, marginBottom: 4 }}>EXP (หมดอายุ)</div>
          <input type="date" value={draft.expDate || ''}
            onChange={e => setDraft(f => ({ ...f, expDate: e.target.value }))}
            style={{ width: '100%', border: '1.5px solid var(--border)', borderRadius: 8,
              padding: '8px 10px', fontSize: 13, background: 'var(--bg)',
              color: 'var(--txt1)', boxSizing: 'border-box', outline: 'none' }} />
        </div>
      </div>
      {field('ผู้จำหน่าย / Supplier', 'supplier')}

      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button onClick={onCancel} disabled={saving}
          style={{ flex: '0 0 auto', border: '1.5px solid var(--border)', borderRadius: 10,
            padding: '9px 16px', fontSize: 13, background: 'var(--bg)',
            color: 'var(--txt2)', cursor: 'pointer', fontWeight: 600 }}>
          ยกเลิก
        </button>
        <button onClick={onSplit} disabled={saving}
          style={{ flex: '1 1 auto', border: '1.5px solid #F59E0B', borderRadius: 10,
            padding: '9px 16px', fontSize: 13, background: '#FEF3C7',
            color: '#92600A', cursor: 'pointer', fontWeight: 600, textAlign: 'center' }}>
          ✂️ แบ่ง LOT ({totalQty})
        </button>
        <button onClick={onSave} disabled={saving}
          style={{ flex: '1 1 auto', border: 'none', borderRadius: 10,
            padding: '9px 16px', fontSize: 13, background: 'var(--red)',
            color: '#fff', cursor: 'pointer', fontWeight: 700, textAlign: 'center',
            opacity: saving ? 0.6 : 1 }}>
          {saving ? '⏳...' : '💾 บันทึก'}
        </button>
      </div>
      {/* ปุ่มลบ — เฉพาะ Owner */}
      {isOwner && (
        <button onClick={onDelete} disabled={saving}
          style={{ width: '100%', marginTop: 8, border: '1.5px solid #FECACA',
            borderRadius: 10, padding: '8px 0', fontSize: 12, background: 'transparent',
            color: '#DC2626', cursor: 'pointer', fontWeight: 600, textAlign: 'center' }}>
          🗑️ ลบ LOT นี้
        </button>
      )}
    </div>
  )
}

/* ── Split Form Component ────────────────────────────────────── */
function SplitForm({ draft, setDraft, totalQty, unitUse, saving, onCancel, onConfirm }) {
  const qtyA = Number(draft.qtyA) || 0
  const qtyB = Number(draft.qtyB) || 0
  const sum  = qtyA + qtyB
  const ok   = sum === totalQty && qtyA > 0 && qtyB > 0

  function subField(label, keyA, keyB, type = 'text') {
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 700,
          marginBottom: 4, textTransform: 'uppercase' }}>{label}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <input type={type} value={draft[keyA] || ''}
            onChange={e => setDraft(f => ({ ...f, [keyA]: e.target.value }))}
            style={{ border: '1.5px solid #86EFAC', borderRadius: 8, padding: '7px 10px',
              fontSize: 13, background: '#F0FDF4', color: 'var(--txt1)',
              width: '100%', boxSizing: 'border-box', outline: 'none' }} />
          <input type={type} value={draft[keyB] || ''}
            onChange={e => setDraft(f => ({ ...f, [keyB]: e.target.value }))}
            style={{ border: '1.5px solid #FDE68A', borderRadius: 8, padding: '7px 10px',
              fontSize: 13, background: '#FFFBEB', color: 'var(--txt1)',
              width: '100%', boxSizing: 'border-box', outline: 'none' }} />
        </div>
      </div>
    )
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#92600A', marginBottom: 12 }}>
        ✂️ แบ่ง LOT — รวม {totalQty} {unitUse}
      </div>

      {/* Column headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 700,
          color: '#16A34A', background: '#DCFCE7', borderRadius: 8, padding: '4px 0' }}>
          Sub-lot A
        </div>
        <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 700,
          color: '#B45309', background: '#FEF3C7', borderRadius: 8, padding: '4px 0' }}>
          Sub-lot B
        </div>
      </div>

      {subField('Lot No.', 'lotNoA', 'lotNoB')}

      {/* Qty fields with validation */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>
          จำนวน ({unitUse})
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <input type="number" min="1" value={draft.qtyA || ''}
            onChange={e => setDraft(f => ({ ...f, qtyA: e.target.value }))}
            style={{ border: `1.5px solid ${ok || !qtyA ? '#86EFAC' : '#FCA5A5'}`,
              borderRadius: 8, padding: '7px 10px', fontSize: 14, fontWeight: 700,
              background: '#F0FDF4', color: 'var(--txt1)',
              width: '100%', boxSizing: 'border-box', outline: 'none', textAlign: 'center' }} />
          <input type="number" min="1" value={draft.qtyB || ''}
            onChange={e => setDraft(f => ({ ...f, qtyB: e.target.value }))}
            style={{ border: `1.5px solid ${ok || !qtyB ? '#FDE68A' : '#FCA5A5'}`,
              borderRadius: 8, padding: '7px 10px', fontSize: 14, fontWeight: 700,
              background: '#FFFBEB', color: 'var(--txt1)',
              width: '100%', boxSizing: 'border-box', outline: 'none', textAlign: 'center' }} />
        </div>
        {/* Sum indicator */}
        <div style={{ textAlign: 'center', fontSize: 11, marginTop: 6, fontWeight: 600,
          color: ok ? '#16A34A' : sum > 0 ? '#DC2626' : 'var(--txt3)' }}>
          {sum > 0 ? `${qtyA} + ${qtyB} = ${sum} ${sum === totalQty ? '✅' : `❌ (ต้องได้ ${totalQty})`}` : `รวมต้องได้ ${totalQty} ${unitUse}`}
        </div>
      </div>

      {subField('MFG (ผลิต)', 'mfgA', 'mfgB', 'date')}
      {subField('EXP (หมดอายุ)', 'expA', 'expB', 'date')}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button onClick={onCancel} disabled={saving}
          style={{ flex: '0 0 auto', border: '1.5px solid var(--border)', borderRadius: 10,
            padding: '9px 16px', fontSize: 13, background: 'var(--bg)',
            color: 'var(--txt2)', cursor: 'pointer', fontWeight: 600 }}>
          ← กลับ
        </button>
        <button onClick={onConfirm} disabled={saving || !ok}
          style={{ flex: 1, border: 'none', borderRadius: 10,
            padding: '9px 16px', fontSize: 13, background: ok ? '#F59E0B' : '#E5E7EB',
            color: ok ? '#fff' : '#9CA3AF', cursor: ok ? 'pointer' : 'not-allowed',
            fontWeight: 700, transition: 'all .15s',
            opacity: saving ? 0.6 : 1 }}>
          {saving ? '⏳ กำลังบันทึก...' : '✅ ยืนยันแบ่ง LOT'}
        </button>
      </div>
    </div>
  )
}
