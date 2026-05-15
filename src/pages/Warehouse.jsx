import { useState, useEffect } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { sortLotsFIFO, getExpStatus } from '../utils/fifo'

const CATS = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'แยม', label: '🍓 แยม' },
  { id: 'ผลไม้', label: '🍋 ผลไม้' },
  { id: 'ไซรัป', label: '🍯 ไซรัป' },
  { id: 'ท็อปปิ้ง', label: '💎 ท็อปปิ้ง' },
  { id: 'วัตถุดิบ', label: '🥛 วัตถุดิบ' },
  { id: 'บรรจุภัณฑ์', label: '🥤 บรรจุ' },
]

export default function Warehouse() {
  const [scope, setScope] = useState('all')
  const [cat, setCat] = useState('all')
  const [search, setSearch] = useState('')
  const [warehouses, setWarehouses] = useState([])
  const [items, setItems] = useState([])
  const [balances, setBalances] = useState([])
  const [lots, setLots] = useState([])
  const [lotItem, setLotItem] = useState(null)

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'warehouses'), snap => {
      setWarehouses(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(w => w.active !== false))
    })
    const u2 = onSnapshot(collection(db, 'items'), snap => {
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => { u1(); u2() }
  }, [])

  useEffect(() => {
    const q = scope === 'all'
      ? query(collection(db, 'stock_balances'))
      : query(collection(db, 'stock_balances'), where('warehouseId', '==', scope))
    const unsub = onSnapshot(q, snap => {
      setBalances(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [scope])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'lot_tracking'), snap => {
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
      const warnLots = itemLots.filter(l => getExpStatus(l.expDate || '01/01/70').status !== 'ok')
      return { item, qty, itemLots, warnLots, status: getStatus(qty, item), pct: getPct(qty, item) }
    })

  function openLotPopup(item, itemLots, warnLots, qty) {
    setLotItem({ item, itemLots, warnLots, qty })
  }

  return (
    <div className="page-pad">
      {/* Topbar */}
      <div className="topbar">
        <span className="topbar-title">คลังสินค้า</span>
        <ConnectionStatus />
      </div>

      {/* Scope selector */}
      <div style={{ padding: '0 1rem' }}>
        <div className="segment">
          <button className={`seg-btn${scope === 'all' ? ' active' : ''}`} onClick={() => setScope('all')}>ทั้งหมด</button>
          {warehouses.map(w => (
            <button key={w.id} className={`seg-btn${scope === w.id ? ' active' : ''}`} onClick={() => setScope(w.id)}>
              {w.name}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="search-wrap">
        <span className="search-icon">🔍</span>
        <input className="search-input" placeholder="ค้นหาวัตถุดิบ..." value={search}
          onChange={e => setSearch(e.target.value)} />
      </div>

      {/* Category chips */}
      <div className="chip-row">
        {CATS.map(c => (
          <button key={c.id} className={`chip${cat === c.id ? ' active' : ''}`} onClick={() => setCat(c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      {/* Stock grid */}
      <div className="stock-grid">
        {rows.length === 0 && (
          <div style={{ gridColumn: 'span 2', textAlign: 'center', color: 'var(--txt3)', padding: 40 }}>
            ไม่มีข้อมูล
          </div>
        )}
        {rows.map(({ item, qty, itemLots, warnLots, status, pct }) => (
          <div key={item.id} className="stock-card">
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
                <button
                  className={`lot-btn${warnLots.length > 0 ? ' warn' : ''}`}
                  onClick={() => openLotPopup(item, itemLots, warnLots, qty)}
                >
                  LOT {itemLots.length}{warnLots.length > 0 ? ' ⚠️' : ''}
                </button>
              )}
            </div>
            <div style={{ fontSize: 10, color: 'var(--txt3)' }}>ตัด: {item.unitUse}</div>
          </div>
        ))}
      </div>

      {/* LOT Popup */}
      {lotItem && <LotPopup data={lotItem} onClose={() => setLotItem(null)} />}
    </div>
  )
}

function LotPopup({ data, onClose }) {
  const { item, itemLots, warnLots, qty } = data

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
          </div>

          {/* LOT blocks */}
          {itemLots.map((lot, idx) => {
            const exp = getExpStatus(lot.expDate || '01/01/70')
            const inWH = lot.inWarehouse || 0
            const inShop = lot.inShop || 0
            const used = lot.used || 0
            const total = inWH + inShop + used

            return (
              <div key={lot.id} style={{ marginBottom: 14, background: 'var(--bg)', borderRadius: 12, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13 }}>LOT {lot.receiveDate}</span>
                    {idx === 0 && (
                      <span style={{ background: '#DCFCE7', color: '#166534', fontSize: 10, fontWeight: 700,
                        padding: '2px 6px', borderRadius: 6 }}>FIFO ออกก่อน</span>
                    )}
                  </div>
                  <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14 }}>{inWH} {item.unitBase}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 8 }}>
                  MFG {lot.mfgDate} › EXP {lot.expDate}
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
