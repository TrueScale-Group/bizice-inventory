import { useState, useEffect } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, doc } from 'firebase/firestore'
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
  { id: 'อื่นๆ', name: 'อื่นๆ', emoji: '🔖' },
]

export default function Warehouse() {
  const [scope, setScope] = useState('')
  const [cat, setCat] = useState('all')
  const [search, setSearch] = useState('')
  const [warehouses, setWarehouses] = useState([])
  const [items, setItems] = useState([])
  const [balances, setBalances] = useState([])
  const [lots, setLots] = useState([])
  const [lotItem, setLotItem] = useState(null)
  const [hoverItem, setHoverItem] = useState(null)
  const [expThresholds, setExpThresholds] = useState({ yellow: 30, red: 7 })

  // โหลด exp thresholds จาก Firestore
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
      if (wList.length > 0) setScope(prev => prev || wList[0].id)
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

  function getItemLots(itemId) {
    return sortLotsFIFO(lots.filter(l => l.itemId === itemId))
  }

  const rows = items
    .filter(i => cat === 'all' || i.category === cat)
    .filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()))
    .map(item => {
      const bal = balances.filter(b => b.itemId === item.id)
      const qty = bal.reduce((s, b) => s + (b.qty || 0), 0)
      const itemLots = getItemLots(item.id)
      const warnLots = itemLots.filter(l => getExpStatus(l.expDate || '', expThresholds).status !== 'ok')
      return { item, qty, itemLots, warnLots, status: getStatus(qty, item), pct: getPct(qty, item) }
    })

  function openLotPopup(item, itemLots, warnLots, qty) {
    setLotItem({ item, itemLots, warnLots, qty, expThresholds })
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
              {rows.map(({ item, qty, itemLots, warnLots, status, pct }) => (
                <div key={item.id} className="stock-card" onClick={() => setHoverItem(hoverItem === item.id ? null : item.id)}
                  style={{ cursor: 'pointer', position: 'relative' }}>
                  {/* Unit info trigger icon */}
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
                    <span className="stock-unit"> {item.unitBase}</span>
                  </div>
                  <div className="progress-bar">
                    <div className={`progress-fill ${status}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span className={`badge badge-${status === 'ok' ? 'ok' : status === 'low' ? 'low' : 'out'}`}>
                      {status === 'ok' ? '✅ ปกติ' : status === 'low' ? '⚠️ ใกล้หมด' : '❌ หมด'}
                    </span>
                    {itemLots.length > 0 && (
                      <button className={`lot-btn${warnLots.length > 0 ? ' warn' : ''}`}
                        onClick={e => { e.stopPropagation(); openLotPopup(item, itemLots, warnLots, qty) }}>
                        LOT {itemLots.length}{warnLots.length > 0 ? ' ⚠️' : ''}
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--txt3)' }}>ตัด: {item.unitUse}</div>

                  {/* Unit info tooltip */}
                  {hoverItem === item.id && (
                    <div style={{ marginTop: 8, padding: '10px 12px', background: '#1C1C1E', borderRadius: 12, fontSize: 11, color: '#fff' }}>
                      <div style={{ fontSize: 10, color: '#8E8E93', fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
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

function LotPopup({ data, onClose }) {
  const { item, itemLots, warnLots, qty, expThresholds } = data
  const thr = expThresholds || { yellow: 30, red: 7 }

  // Legend สี EXP
  const expLegend = [
    { color: '#1A7F37', bg: '#DCFCE7', label: `> ${thr.yellow} วัน` },
    { color: '#92600A', bg: '#FEF3C7', label: `${thr.red + 1}–${thr.yellow} วัน` },
    { color: '#FF3B30', bg: '#FEE2E2', label: `≤ ${thr.red} วัน / หมด` },
  ]

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bottom-sheet">
        <div className="sheet-handle" />
        <div className="sheet-header">
          <div>
            <div style={{ fontSize: 20 }}>{item.img} <span style={{ fontFamily: 'Prompt', fontWeight: 700 }}>{item.name}</span></div>
            <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
              ตัด: {item.unitUse} · {item.unitConversion}
            </div>
          </div>
          <button className="sheet-close" onClick={onClose}>✕</button>
        </div>
        <div className="sheet-body">
          {/* Info box */}
          <div style={{ background: '#EFF6FF', borderRadius: 10, padding: 12, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: 'var(--txt2)' }}>Stock คงเหลือ</span>
              <span style={{ fontWeight: 700, fontFamily: 'Prompt' }}>{qty} {item.unitBase}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: 'var(--txt2)' }}>จำนวน Lot</span>
              <span style={{ fontWeight: 700 }}>{itemLots.length} Lot</span>
            </div>
            {warnLots.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: '#D97706' }}>Lot ใกล้หมดอายุ</span>
                <span style={{ fontWeight: 700, color: '#D97706' }}>{warnLots.length} Lot ⚠️</span>
              </div>
            )}
            {/* EXP Color Legend */}
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
          </div>

          {/* LOT blocks */}
          {itemLots.map((lot, idx) => {
            const exp = getExpStatus(lot.expDate || '', thr)
            const inWH = lot.inWarehouse || 0
            const inShop = lot.inShop || 0
            const used = lot.used || 0

            // วันที่แสดงผล DD-MM-YY
            const lotLabel    = formatDateDDMMYY(lot.receiveDate)
            const mfgLabel    = formatDateDDMMYY(lot.mfgDate)
            const expLabel    = formatDateDDMMYY(lot.expDate)

            // สีพื้นหลัง card ตาม exp status
            const cardBg = exp.status === 'expired' ? '#FFF5F5'
                         : exp.status === 'danger'  ? '#FFF5F5'
                         : exp.status === 'warning' ? '#FFFBEB'
                         : 'var(--bg)'

            return (
              <div key={lot.id} style={{ marginBottom: 14, background: cardBg,
                borderRadius: 12, padding: 12,
                border: exp.status === 'expired' ? '1px solid #FECACA'
                      : exp.status === 'danger'  ? '1px solid #FECACA'
                      : exp.status === 'warning' ? '1px solid #FDE68A'
                      : '1px solid transparent' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13 }}>LOT {lotLabel}</span>
                    {idx === 0 && (
                      <span style={{ background: '#DCFCE7', color: '#166534', fontSize: 10, fontWeight: 700,
                        padding: '2px 6px', borderRadius: 6 }}>FIFO ออกก่อน</span>
                    )}
                  </div>
                  <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14 }}>{inWH} {item.unitBase}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 8 }}>
                  MFG {mfgLabel} › EXP {expLabel}
                  {' · '}
                  <span style={{ color: exp.color, fontWeight: 700 }}>{exp.label}</span>
                </div>

                {/* Piece chips */}
                <div style={{ fontSize: 11, color: 'var(--txt2)', marginBottom: 4 }}>STOCK {item.unitBase}:</div>
                <div className="piece-chips">
                  {Array.from({ length: Math.min(inWH, 30) }).map((_, i) => (
                    <div key={`wh-${i}`} className="pc pc-wh" title="คลัง" />
                  ))}
                  {Array.from({ length: Math.min(inShop, 10) }).map((_, i) => (
                    <div key={`sh-${i}`} className="pc pc-shop" title="ร้าน/ส่ง" />
                  ))}
                  {Array.from({ length: Math.min(used, 10) }).map((_, i) => (
                    <div key={`us-${i}`} className="pc pc-used" title="ใช้แล้ว" />
                  ))}
                </div>
                <div style={{ fontSize: 10, color: 'var(--txt3)', marginTop: 6, display: 'flex', gap: 10 }}>
                  <span>🟢 คลัง ({inWH})</span>
                  <span>🟠 ร้าน/ส่ง ({inShop})</span>
                  <span>⬜ ใช้แล้ว ({used})</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
