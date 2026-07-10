import { useState, useEffect } from 'react'
import { db } from '../firebase'
import {
  collection, query, where, onSnapshot, doc,
  updateDoc, addDoc, serverTimestamp, writeBatch, deleteDoc, increment
} from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { Toast } from '../components/Toast'
import AdjustStockModal from '../components/AdjustStockModal'
import { sortLotsFIFO, getExpStatus, formatDateDDMMYY } from '../utils/fifo'
import { COL } from '../constants/collections'
import { useSession } from '../hooks/useSession'
import { useItems, useItemsLoaded } from '../hooks/useItems'
import { useStockBalances } from '../hooks/useStock'
import { formatStockQty, getStockStatus, balanceId, qtyToUse, parseConvFactor } from '../utils/unit'
import { CAT_ORDER } from '../utils/sortItems'

const CATS = [
  { id: 'all',        name: 'ทั้งหมด',    emoji: '🔍' },
  { id: 'แยม',       name: 'แยม',        emoji: '🍓' },
  { id: 'ผลไม้',     name: 'ผลไม้',      emoji: '🍋' },
  { id: 'ไซรัป',     name: 'ไซรัป',      emoji: '🍯' },
  { id: 'ท็อปปิ้ง',  name: 'ท็อปปิ้ง',   emoji: '💎' },
  { id: 'วัตถุดิบ',  name: 'วัตถุดิบ',   emoji: '🥛' },
  { id: 'ขนม',       name: 'ขนม',        emoji: '🍪' },
  { id: 'บรรจุภัณฑ์', name: 'บรรจุ',     emoji: '🥤' },
  { id: 'อื่นๆ',     name: 'อื่นๆ',      emoji: '🔖' },
]

// Warehouse color palette (index-based)
const WH_COLORS = ['#34C759', '#FF9500', '#007AFF', '#AF52DE', '#FF2D55']
const WH_BG     = ['#DCFCE7', '#FEF3C7', '#DBEAFE', '#F3E8FF', '#FFE4E6']

/* ── LOT helpers (shared: card badges + LOT popup) — รองรับ 2 schema (locationQty map / legacy inWarehouse+inShop) ── */
function getLotQtyTotal(lot) {
  // totalQty = ยอดรับสะสมที่ถูกต้องเสมอ (qty เคยเพี้ยนจาก bug โอนซ้ำเข้า lot เดิม — เชื่อ totalQty ก่อน)
  if (lot.totalQty != null) return Number(lot.totalQty) || 0
  if (lot.qty != null) return lot.qty
  if (lot.locationQty) return Object.values(lot.locationQty).reduce((s, v) => s + v, 0)
  return (lot.inWarehouse || 0) + (lot.inShop || 0) + (lot.used || 0)
}
function getLotLocationBreakdown(lot) {
  if (lot.locationQty && Object.keys(lot.locationQty).length > 0) return lot.locationQty
  const bd = {}
  const whId = lot.warehouseId || '__main__'
  if ((lot.inWarehouse || 0) > 0) bd[whId] = lot.inWarehouse
  if ((lot.inShop || 0) > 0) bd['__shop__'] = lot.inShop
  if (Object.keys(bd).length === 0 && (lot.qty || 0) > 0 && whId) bd[whId] = lot.qty
  return bd
}
/** ใช้หมดแล้ว = ไม่เหลือ stock ที่คลัง/ร้านไหนเลย — ใช้ซ่อน LOT ออกจากลิสต์ที่แสดงผล */
function isLotDepleted(lot) {
  const total = getLotQtyTotal(lot)
  if (total <= 0) return false
  const active = Object.values(getLotLocationBreakdown(lot)).reduce((s, v) => s + v, 0)
  return active <= 0.0001
}

export default function Warehouse({ wh: scope, setWh: setScope, warehouses }) {
  const [loading, setLoading]     = useState(true)
  const [cat, setCat]             = useState('all')
  const [search, setSearch]       = useState('')
  const items = useItems()                 // shared singleton — ลด Inv_items reads
  const itemsLoaded = useItemsLoaded()
  // balances — shared singleton: owner เลือก 'all' = ทุกคลัง · staff = สาขาเดียว (scope)
  const balances = useStockBalances(scope || 'all')
  const [lots, setLots]           = useState([])
  const [lotItem, setLotItem]     = useState(null)
  const [historyItem, setHistoryItem] = useState(null)   // 👓 history popup
  const [hoverItem, setHoverItem] = useState(null)
  const [expThresholds, setExpThresholds] = useState({ yellow: 30, red: 7 })
  const [adjustItem, setAdjustItem] = useState(null)   // { item, currentQty }
  const [toast, setToast] = useState('')

  const { name, phone, isOwner } = useSession()
  const session = window._bizSession || {}

  useEffect(() => {
    const unsub = onSnapshot(doc(db, COL.APP_SETTINGS, 'exp_thresholds'), snap => {
      if (snap.exists()) setExpThresholds(snap.data())
    })
    return () => unsub()
  }, [])

  // items มาจาก useItems() (shared) — เคลียร์ loading เมื่อโหลดเสร็จ
  useEffect(() => { if (itemsLoaded) setLoading(false) }, [itemsLoaded])

  // balances ย้ายไป useStockBalances(scope || 'all') แล้ว (ดูบรรทัดประกาศด้านบน)

  // โหลด LOT ทุกคลังเสมอ — popup ต้องเห็นทั้งครอบครัว (แม่คลังกลาง + ลูกสาขา) เพื่อตามของจนใช้หมด
  // (Dashboard subscribe ทั้ง collection อยู่แล้ว — ไม่ได้เพิ่ม read จริง)
  useEffect(() => {
    const unsub = onSnapshot(collection(db, COL.LOT_TRACKING), snap => {
      setLots(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // หา balance doc ของ item ใน scope (warehouse ที่เลือก) — V2 schema: doc id = `${wh}_${itemId}`
  function getBalance(itemId) {
    if (!scope) return null
    return balances.find(b => b.itemId === itemId && b.warehouseId === scope)
  }

  function getStatus(qty, itemId) {
    const bal = getBalance(itemId)
    return getStockStatus(qty, bal?.minQty || 0)
  }

  function getPct(qty, item) {
    // ไม่มี maxQty แล้ว — ใช้ minQty * 5 เป็น reference เผื่อแสดง progress
    const bal = getBalance(item.id)
    const ref = (bal?.minQty || 0) * 5
    if (!ref) return Math.min(100, qty > 0 ? 50 : 0)
    return Math.min(100, Math.round((qty / ref) * 100))
  }

  // กรอง LOT ที่ถูก split ออกแล้ว (แสดงแค่ sub-lots ที่ active) + LOT ที่ใช้หมดแล้ว (ไม่ต้องโชว์ค้าง)
  function getItemLots(itemId) {
    return sortLotsFIFO(lots.filter(l => l.itemId === itemId && l.status !== 'split' && !isLotDepleted(l)))
  }

  const EXP_ORDER = { expired: 0, danger: 1, warning: 2, ok: 3 }

  const rows = items
    .filter(i => {
      const vis = i.visibleIn || {}
      if (!scope) {
        // ดูทั้งหมด → ซ่อนถ้าทุกคลังถูก set false หมด
        const allHidden = Object.keys(vis).length > 0 && Object.values(vis).every(v => v === false)
        return !allHidden
      }
      // ดูเฉพาะคลัง scope → ซ่อนถ้าคลังนั้น false
      return vis[scope] !== false
    })
    .filter(i => cat === 'all' || i.category === cat)
    .filter(i => !search || (i.displayName || i.name).toLowerCase().includes(search.toLowerCase()) || i.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      // เรียงตาม Master Data: ตำแหน่งหมวด (CAT_ORDER) → sortOrder → name
      // โชว์ cat==='all' ปนทุกหมวด จึงต้องใช้ตำแหน่งหมวดเป็น key หลัก
      const cia = CAT_ORDER.indexOf(a.category); const ca = cia < 0 ? 999 : cia
      const cib = CAT_ORDER.indexOf(b.category); const cb = cib < 0 ? 999 : cib
      if (ca !== cb) return ca - cb
      const oa = a.sortOrder ?? 999
      const ob = b.sortOrder ?? 999
      if (oa !== ob) return oa - ob
      return (a.name || '').localeCompare(b.name || '', 'th')
    })
    .map(item => {
      const bal = balances.filter(b => b.itemId === item.id)
      const qty = bal.reduce((s, b) => s + (b.qty || 0), 0)
      // item ปิดระบบ LOT (lotEnabled=false) → ไม่โชว์ badge/popup LOT เลย (ของไม่มีวันหมดอายุ)
      const familyLots = item.lotEnabled === false ? [] : getItemLots(item.id)   // ทั้งครอบครัว ทุกคลัง — ส่งให้ popup
      // badge บนการ์ด (📦 N · EXP) ยังนับเฉพาะคลังที่กำลังดู — ยอดหน้ารายการเป็นราย-คลัง
      const itemLots = scope ? familyLots.filter(l => (l.warehouseId || '') === scope) : familyLots
      const warnLots = itemLots.filter(l => getExpStatus(l.expDate || '', expThresholds).status !== 'ok')
      // หา worst EXP status ในทุก lot ของ item นี้ (เฉพาะคลังที่ดู)
      let worstExp = null
      for (const lot of itemLots) {
        const exp = getExpStatus(lot.expDate || '', expThresholds)
        if (!worstExp || EXP_ORDER[exp.status] < EXP_ORDER[worstExp.status]) worstExp = exp
      }
      return { item, qty, itemLots, familyLots, warnLots, worstExp, status: getStatus(qty, item.id), pct: getPct(qty, item) }
    })

  function openLotPopup(item, familyLots, warnLots, qty) {
    setLotItem({ item, itemLots: familyLots, warnLots, qty, expThresholds, warehouses, session,
      currentScope: scope })   // scope ใช้เป็น default คลังตอนเพิ่ม LOT + ป้าย "Stock คงเหลือ"
  }

  return (
    <div className="page-pad">
      {loading && (
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'48px 0',gap:12}}>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          <div style={{width:40,height:40,borderRadius:'50%',border:'3px solid #F3F4F6',borderTopColor:'#E31E24',animation:'spin .7s linear infinite'}}/>
          <div style={{fontSize:13,fontWeight:700,color:'#9CA3AF'}}>กำลังโหลด...</div>
        </div>
      )}

      {/* Search */}
      <div style={{ padding: '0 1rem', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="search-wrap" style={{ margin: 0, flex: 1 }}>
          <span className="search-icon">🔍</span>
          <input className="search-input" placeholder="ค้นหาวัตถุดิบ..." value={search}
            onChange={e => setSearch(e.target.value)} />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')} title="ล้าง">×</button>
          )}
        </div>
        <span style={{ fontSize: 12, color: 'var(--txt3)', whiteSpace: 'nowrap', fontWeight: 600 }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 8, padding: 8 }}>
              {rows.map(({ item, qty, itemLots, familyLots, warnLots, worstExp, status, pct }) => (
                <div key={item.id} className="stock-card" onClick={() => setHoverItem(hoverItem === item.id ? null : item.id)}
                  style={{ cursor: 'pointer', position: 'relative', minWidth: 0, overflow: 'hidden',
                    background: hoverItem === item.id ? '#FFF1F5' : undefined,
                    borderColor: hoverItem === item.id ? '#FFC2D6' : undefined,
                    gridColumn: hoverItem === item.id ? '1 / -1' : 'auto' }}>
                  <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 2,
                    width: 20, height: 20, borderRadius: '50%',
                    background: hoverItem === item.id ? 'var(--red)' : '#FCE4EC',
                    border: hoverItem === item.id ? 'none' : '1px solid #F8BBD0',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: hoverItem === item.id ? 11 : 13,
                    color: hoverItem === item.id ? '#fff' : '#C2185B',
                    fontWeight: 700, transition: 'all .15s', flexShrink: 0,
                    lineHeight: 1 }}>
                    {hoverItem === item.id ? '×' : '⟳'}
                  </div>
                  {hoverItem !== item.id && (<>
                  <div className="stock-emoji">{item.img || '📦'}</div>
                  <div className="stock-name">{item.displayName || item.name}</div>
                  <div className="stock-cat">{item.category}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    <span className={`stock-qty ${status}`} style={{ fontSize: 17, fontWeight: 700, display: 'block', lineHeight: 1.2 }}>
                      {formatStockQty(qty, item)}
                    </span>
                    {(() => {
                      const unitUse = item.unitUse || item.unitBase || ''
                      const formatted = formatStockQty(qty, item)
                      const simple = `${Number.isInteger(qty) ? qty : Number(Number(qty).toFixed(2))} ${unitUse}`
                      if (!unitUse || formatted === simple) return null
                      return (
                        <span style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 500, display: 'block', marginTop: 2 }}>
                          รวม {Number.isInteger(qty) ? qty : Number(Number(qty).toFixed(2))} {unitUse}
                        </span>
                      )
                    })()}
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
                          onClick={e => { e.stopPropagation(); openLotPopup(item, familyLots, warnLots, qty) }}
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
                  <div style={{ fontSize: 10, color: 'var(--txt3)' }}>
                    ตัด: {item.unitUse}{item.unitConversion ? ` · ${item.unitConversion}` : ''}
                  </div>
                  </>)}

                  {/* ── ด้านหลังการ์ด (พลิก) — สีชมพูทั้งใบ ข้อมูลครบ (ไม่มี emoji) ── */}
                  {hoverItem === item.id && (
                    <div className="stock-card-back" style={{ fontSize: 11, color: '#5C2A3E',
                      display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {/* ชื่อวัตถุดิบ (เหลือแค่ชื่อ) */}
                      <div style={{ paddingRight: 22, fontSize: 14, fontWeight: 800, color: '#3D1A28',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.displayName || item.name}
                      </div>
                      {/* หน่วยบรรจุ + ราคา (แถวเดียว) */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, color: '#C2185B', fontWeight: 700, flexShrink: 0 }}>หน่วยบรรจุ</span>
                        {item.unitConversion ? (
                          <span style={{ background: '#FFD4E0', color: '#5C2A3E', borderRadius: 6,
                            padding: '2px 8px', fontWeight: 700, fontSize: 10.5 }}>
                            {item.unitConversion}
                          </span>
                        ) : (
                          <span style={{ color: '#B8859A', fontSize: 10 }}>ไม่มีข้อมูลหน่วย</span>
                        )}
                        {item.unitPrice ? (
                          <span style={{ fontSize: 10, color: '#8B5A6F', fontWeight: 600, marginLeft: 'auto' }}>
                            ฿{Number(item.unitPrice).toFixed(2)}/{item.unitUse}
                          </span>
                        ) : null}
                      </div>
                      {/* MAX / MIN — 2 กล่องสถิติเต็มกว้าง (ไม่โชว์ชื่อคลังซ้ำ เพราะ toggle บนบอกแล้ว) */}
                      {scope && (() => {
                        const bal = getBalance(item.id)
                        const unitLabel = (u) =>
                          u === 'buy' ? (item.unitBuy || item.unitBase || '')
                          : u === 'sub' ? (item.unitSubRaw || item.unitSub || '')
                          : (item.unitUseRaw || item.unitUse || '')
                        // หน่วย default = หน่วยใหญ่สุด (buy/ลัง) ตรงกับที่ Settings โชว์เป็นค่าเริ่มต้น
                        const defUnit = (item.unitBuy || item.unitBase) ? 'buy'
                          : (item.unitUseRaw || item.unitUse) ? 'use' : 'sub'
                        const minRaw = bal?.minQtyRaw
                        const minStr = (minRaw != null && minRaw !== '')
                          ? `${minRaw} ${unitLabel(bal?.minUnit || defUnit)}`
                          : (bal?.minQty ? formatStockQty(bal.minQty, item) : '—')
                        const lim = item.stockLimits?.[scope] || {}
                        const maxStr = lim.maxQty ? `${lim.maxQty} ${unitLabel(lim.maxUnit || defUnit)}` : '—'
                        return (
                          <div style={{ display: 'flex', gap: 7 }}>
                            <div style={{ flex: 1, background: '#FFF7ED', border: '1px solid #FED7AA',
                              borderRadius: 8, padding: '6px 10px', textAlign: 'center' }}>
                              <div style={{ fontSize: 9, fontWeight: 700, color: '#EA580C' }}>🟧 MIN</div>
                              <div style={{ fontSize: 13, fontWeight: 800, color: '#C2410C', whiteSpace: 'nowrap' }}>{minStr}</div>
                            </div>
                            <div style={{ flex: 1, background: '#F0FDF4', border: '1px solid #BBF7D0',
                              borderRadius: 8, padding: '6px 10px', textAlign: 'center' }}>
                              <div style={{ fontSize: 9, fontWeight: 700, color: '#16A34A' }}>🟩 MAX</div>
                              <div style={{ fontSize: 13, fontWeight: 800, color: '#15803D', whiteSpace: 'nowrap' }}>{maxStr}</div>
                            </div>
                          </div>
                        )
                      })()}
                      {/* ปุ่ม 3 อัน เรียงนอนเต็มกว้าง (กดง่าย ไม่ตัดคำ) */}
                      <div style={{ display: 'flex', gap: 7 }}>
                        {isOwner() && (
                          <button onClick={e => { e.stopPropagation(); setAdjustItem({ item, currentQty: qty }) }}
                            style={{ flex: 1, padding: '9px 6px', borderRadius: 9, border: 'none',
                              background: '#FF6B9D', color: '#fff', fontSize: 11.5, fontWeight: 700,
                              cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: '0 1px 3px rgba(255,107,157,.3)' }}>
                            ⚖️ ปรับยอด
                          </button>
                        )}
                        {item.lotEnabled !== false && (
                          <button onClick={e => { e.stopPropagation(); openLotPopup(item, familyLots, warnLots, qty) }}
                            style={{ flex: 1, padding: '9px 6px', borderRadius: 9, border: '1px solid #FFD4E0',
                              background: '#fff', color: '#C2185B', fontSize: 11.5, fontWeight: 700,
                              cursor: 'pointer', whiteSpace: 'nowrap' }}>
                            📦 LOT ({itemLots.length})
                          </button>
                        )}
                        <button onClick={e => { e.stopPropagation(); setHistoryItem(item) }}
                          style={{ flex: 1, padding: '9px 6px', borderRadius: 9, border: '1px solid #DBEAFE',
                            background: '#fff', color: '#1D4ED8', fontSize: 11.5, fontWeight: 700,
                            cursor: 'pointer', whiteSpace: 'nowrap' }}
                          title="ดูประวัติย้อนหลังทุกเหตุการณ์">
                          👓 ประวัติ
                        </button>
                      </div>
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

      {/* 👓 History Popup */}
      {historyItem && (
        <ItemHistoryPopup item={historyItem} warehouses={warehouses}
          currentScope={scope}
          onClose={() => setHistoryItem(null)} />
      )}

      {/* Adjust Stock Modal (Owner only) */}
      {adjustItem && (
        <AdjustStockModal
          open={!!adjustItem}
          onClose={() => setAdjustItem(null)}
          item={adjustItem.item}
          currentQty={adjustItem.currentQty}
          warehouses={warehouses}
          defaultWarehouseId={scope}
          staffPhone={phone}
          staffName={name}
          onSuccess={msg => setToast(msg)}
        />
      )}

      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   LotPopup — แสดง + แก้ไข + แบ่ง LOT
───────────────────────────────────────────────────────────── */
function LotPopup({ data, onClose }) {
  const { item, itemLots: initLots, warnLots, qty, expThresholds,
          warehouses = [], session = {}, currentScope = '' } = data
  // คลังที่ถูก lock ตาม scope หน้า (ถ้าเลือก "ทั้งหมด" จะปล่อยให้เลือกเอง)
  const lockedWh = currentScope && warehouses.find(w => w.id === currentScope) ? currentScope : ''
  const thr = expThresholds || { yellow: 30, red: 7 }
  const role    = session.role || 'viewer'
  const canEdit = ['editor', 'staff', 'owner', 'admin'].includes(role)
  const canManage = role === 'owner' || role === 'admin'   // ลบ LOT — Owner + Admin

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
  const [addOpen, setAddOpen] = useState(false)           // เพิ่ม LOT
  const [addDraft, setAddDraft] = useState({})
  const [mergeMode, setMergeMode] = useState(false)       // 🔀 โหมดรวม LOT
  const [mergeSel, setMergeSel]   = useState([])          // lot ids ที่เลือก (เฉพาะ LOT แม่ คลังเดียวกัน)
  const [mergePrimary, setMergePrimary] = useState('')    // LOT ที่เก็บข้อมูล (Lot No./วันที่/EXP) ไว้

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

  /** qty รวมของ lot นี้ (รับมาทั้งหมด) — เชื่อ totalQty ก่อน (qty เคยเพี้ยนจาก bug โอนซ้ำ) */
  function getLotQty(lot) {
    return getLotQtyTotal(lot)
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

  // ── Edit handlers ─────────────────────────────────────────
  function startEdit(lot) {
    setEditingId(lot.id)
    setEditDraft({
      lotNo:       lot.lotNo || '',
      receiveDate: lot.receiveDate || '',
      mfgDate:     lot.mfgDate || '',
      expDate:     lot.expDate || '',
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

  // ── เพิ่ม LOT ──────────────────────────────────
  function startAddLot() {
    const today  = new Date()
    const isoDate = today.toISOString().slice(0, 10)  // YYYY-MM-DD
    // Auto LOT No = AUTO-YYMMDD-HHMM (เปลี่ยนได้ภายหลัง)
    const yy = String(today.getFullYear()).slice(-2)
    const mm = String(today.getMonth() + 1).padStart(2, '0')
    const dd = String(today.getDate()).padStart(2, '0')
    const hh = String(today.getHours()).padStart(2, '0')
    const mi = String(today.getMinutes()).padStart(2, '0')
    const autoNo = `AUTO-${yy}${mm}${dd}-${hh}${mi}`
    setAddDraft({
      lotNo:       autoNo,
      receiveDate: isoDate,
      mfgDate:     '',
      expDate:     '',
      warehouseId: lockedWh || warehouses[0]?.id || '',   // lock ตาม scope ถ้ามี
      qty:         '',
      alsoAdjustStock: false,
    })
    setAddOpen(true)
    setEditingId(null)
    setSplitOpen(false)
    setError('')
  }

  async function saveAddLot() {
    setError('')
    const qty = parseFloat(addDraft.qty) || 0
    if (!qty || qty <= 0) { setError('ระบุจำนวน LOT'); return }
    if (!addDraft.warehouseId) { setError('เลือกคลัง'); return }
    setSaving(true)
    try {
      const now = serverTimestamp()
      const batch = writeBatch(db)
      const lotRef = doc(collection(db, COL.LOT_TRACKING))
      batch.set(lotRef, {
        itemId:       item.id,
        itemName:     item.name,
        warehouseId:  addDraft.warehouseId,
        lotNo:        addDraft.lotNo.trim() || '',
        receiveDate:  addDraft.receiveDate || '',
        mfgDate:      addDraft.mfgDate || '',
        expDate:      addDraft.expDate || '',
        qty,
        locationQty:  { [addDraft.warehouseId]: qty },
        // dual-schema: ให้ FIFO/EXP (ที่อ่าน inWarehouse) มองเห็นล็อต manual ด้วย
        totalQty:     qty,
        inWarehouse:  qty,
        inShop:       0,
        used:         0,
        source:       'Backfill (manual)',
        status:       'active',
        createdAt:    now,
      })
      // เลือก: ปรับ stock ตาม
      if (addDraft.alsoAdjustStock) {
        const balRef = doc(db, COL.STOCK_BALANCES, `${addDraft.warehouseId}_${item.id}`)
        batch.set(balRef, {
          warehouseId:   addDraft.warehouseId,
          itemId:        item.id,
          qty:           increment(qty),
          unit:          item.unitUse || '',
          lastUpdated:   now,
          lastUpdatedBy: session.phone || '',
        }, { merge: true })
        // movement
        const movRef = doc(collection(db, COL.STOCK_MOVEMENTS))
        batch.set(movRef, {
          type:         'adjust',
          itemId:       item.id,
          itemName:     item.name,
          warehouseId:  addDraft.warehouseId,
          qty,
          unit:         item.unitUse || '',
          qtyUse:       qty,
          unitUse:      item.unitUse || '',
          adjustReason: 'เพิ่ม LOT (Backfill)',
          note:         `LOT ${addDraft.lotNo || '-'} · ${addDraft.receiveDate}`,
          staffPhone:   session.phone || '',
          staffName:    session.name || '',
          timestamp:    now,
        })
      }
      const audRef = doc(collection(db, COL.AUDIT_LOGS))
      batch.set(audRef, {
        action:      'add_lot_backfill',
        staffPhone:  session.phone || '',
        staffName:   session.name || '',
        warehouseId: addDraft.warehouseId,
        detail:      `เพิ่ม LOT: ${item.name} ${qty} ${item.unitUse}${addDraft.alsoAdjustStock ? ' (+stock)' : ''}`,
        timestamp:   now,
      })
      await batch.commit()
      setAddOpen(false)
      setAddDraft({})
    } catch (e) {
      setError(e.message || 'บันทึก LOT ล้มเหลว')
    } finally {
      setSaving(false)
    }
  }

  // ── รวม LOT (merge) ────────────────────────────
  // use case: ของล็อตเดียวกันแต่กลายเป็นหลาย doc (รับเพิ่ม/กดซ่อม Reconcile) → ยุบรวมเป็นใบเดียว
  function toggleMergeMode() {
    setMergeMode(m => !m)
    setMergeSel([]); setMergePrimary('')
    setEditingId(null); setAddOpen(false); setSplitOpen(false); setError('')
  }

  function toggleMergeSelect(lot) {
    if (lot.parentLotId) return   // รวมได้เฉพาะ LOT แม่ (ลูกจากการโอนจะถูกย้ายตามแม่หลักอัตโนมัติ)
    setMergeSel(prev => {
      const next = prev.includes(lot.id) ? prev.filter(id => id !== lot.id) : [...prev, lot.id]
      setMergePrimary(p => next.includes(p) ? p : (next[0] || ''))
      return next
    })
  }

  async function confirmMerge() {
    setError('')
    const members = mergeSel.map(id => lots.find(l => l.id === id)).filter(Boolean)
    if (members.length < 2) { setError('เลือกอย่างน้อย 2 LOT'); return }
    const primary = members.find(l => l.id === mergePrimary) || members[0]
    const whId = primary.warehouseId || ''
    if (members.some(l => (l.warehouseId || '') !== whId)) { setError('รวมได้เฉพาะ LOT ที่อยู่คลังเดียวกัน'); return }
    const others = members.filter(l => l.id !== primary.id)
    setSaving(true)
    try {
      const now   = serverTimestamp()
      const batch = writeBatch(db)
      // รวมยอด: totalQty/used = ผลบวก · locationQty = รวมคงเหลือรายคลัง (invariant total = คงเหลือ+used+โอนออก คงเดิม)
      let totalQty = 0, used = 0
      const bd = {}
      members.forEach(m => {
        totalQty += getLotQty(m)
        used     += Number(m.used) || 0
        Object.entries(getLocationBreakdown(m)).forEach(([wh, q]) => {
          if (q > 0) bd[wh] = (bd[wh] || 0) + q
        })
      })
      batch.update(doc(db, COL.LOT_TRACKING, primary.id), {
        totalQty, qty: totalQty, used,
        locationQty: bd,
        inWarehouse: bd[whId] || 0,
        inShop:      bd['__shop__'] || 0,
        mergedFrom:  others.map(o => o.id),
        updatedAt:   now,
        updatedBy:   session.name || 'unknown',
      })
      // LOT ลูก (โอนไปสาขา) ของใบที่ถูกยุบ → ย้าย parent มาที่ใบหลัก ให้ family view ตามต่อได้
      const orphans = lots.filter(l => l.parentLotId && others.some(o => o.id === l.parentLotId))
      orphans.forEach(c => batch.update(doc(db, COL.LOT_TRACKING, c.id), { parentLotId: primary.id, updatedAt: now }))
      others.forEach(o => batch.delete(doc(db, COL.LOT_TRACKING, o.id)))
      const audRef = doc(collection(db, COL.AUDIT_LOGS))
      batch.set(audRef, {
        action:      'lot_merge',
        itemId:      item.id,
        itemName:    item.name,
        lotId:       primary.id,
        warehouseId: whId,
        merged: others.map(o => ({
          id: o.id, lotNo: o.lotNo || '', receiveDate: o.receiveDate || '',
          expDate: o.expDate || '', qty: getLotQty(o), used: Number(o.used) || 0,
        })),
        totalQty,
        detail: `รวม ${members.length} LOT → LOT ${getLotDisplay(primary)} (${item.name} รวม ${totalQty} ${item.unitUse})`,
        by: session.name || 'unknown',
        at: now,
      })
      await batch.commit()
      // Optimistic update — ลบใบที่ถูกยุบ อัปเดตใบหลัก ย้าย parent ของลูก
      setLots(prev => prev
        .filter(l => !others.some(o => o.id === l.id))
        .map(l => l.id === primary.id
          ? { ...l, totalQty, qty: totalQty, used, locationQty: bd, inWarehouse: bd[whId] || 0, inShop: bd['__shop__'] || 0 }
          : orphans.some(c => c.id === l.id) ? { ...l, parentLotId: primary.id } : l))
      setMergeMode(false); setMergeSel([]); setMergePrimary('')
    } catch (e) {
      setError('รวม LOT ไม่สำเร็จ: ' + e.message)
    }
    setSaving(false)
  }

  async function saveEdit(lot) {
    setSaving(true); setError('')
    try {
      const updates = {
        lotNo:       (editDraft.lotNo || '').trim() || 'Start',
        receiveDate: editDraft.receiveDate || '',
        mfgDate:     editDraft.mfgDate || '',
        expDate:     editDraft.expDate || '',
        isStartLot:  !(editDraft.lotNo || '').trim() || (editDraft.lotNo || '').trim() === 'Start',
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
          lotNo:       lot.lotNo || '',
          receiveDate: lot.receiveDate || '',
          mfgDate:     lot.mfgDate || '',
          expDate:     lot.expDate || '',
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
        totalQty:     qtyA, inWarehouse: qtyA, inShop: 0, used: 0,
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
        totalQty:     qtyB, inWarehouse: qtyB, inShop: 0, used: 0,
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

  // LOT popup = มุมมอง "ทั้งครอบครัว ทุกคลัง" เสมอ (แทนกฎ §9.2/9.3 เดิมที่แยกคลัง — เจ้าของสั่ง 6 ก.ค. 2569)
  // เหตุผล: LOT คือของล็อตเดียวกัน ต้องตามได้ตั้งแต่รับเข้าคลังกลาง → โอนสาขา → จนใช้หมด
  const sortedLots = sortLotsFIFO(lots)
  // ใช้หมดแล้ว (ไม่เหลือ stock ที่คลังไหนเลย) → ซ่อนออกจากลิสต์ ไม่ต้องโชว์ค้างให้รก
  const visibleLots = sortedLots.filter(lot => !isLotDepleted(lot))

  // รวม LOT ครอบครัวเดียว (แม่+ลูกทุกสาขา) เป็นการ์ดเดียว
  // แสดงคงเหลือจริงรายคลัง + ใช้แล้วรวม (เช่น รับ 80: คลังกลาง 40 / สาขา 25 / ใช้แล้ว 15)
  const displayLots = (() => {
    const groups = new Map()
    for (const l of visibleLots) {
      const rootId = l.parentLotId || l.id
      if (!groups.has(rootId)) groups.set(rootId, [])
      groups.get(rootId).push(l)
    }
    const units = []
    for (const [rootId, members] of groups) {
      const root = members.find(l => l.id === rootId) || members[0]
      const bd = {}
      members.forEach(m => {
        Object.entries(getLocationBreakdown(m)).forEach(([whId, q]) => {
          if (q > 0) bd[whId] = (bd[whId] || 0) + q
        })
      })
      // ยอดรับของครอบครัว = totalQty ของแม่ · ถ้าแม่หมด/ถูกซ่อนไปแล้ว fallback รวมจากลูกที่เหลือ
      const total = members.some(l => l.id === rootId)
        ? getLotQty(root)
        : members.reduce((s, m) => s + getLotQty(m), 0)
      units.push({ ...root, _familyBd: bd, _familyTotal: total, _familyCount: members.length })
    }
    return sortLotsFIFO(units)
  })()

  // นับ LOT ใกล้หมดอายุจาก "การ์ดที่แสดงจริง" (ครอบครัวรวมทุกคลัง) — ให้ตรงกับ "จำนวน Lot" เสมอ
  // เดิมใช้ warnLots ที่หน้ารายการนับเฉพาะคลังที่ดู → เปิดจากสาขานับได้ 1 แต่การ์ดโชว์ 2 (เลขขัดกัน)
  const warnCount = displayLots.filter(l => getExpStatus(l.expDate || '', thr).status !== 'ok').length

  return (
    <div className="modal-backdrop"
      onClick={e => { e.stopPropagation(); e.preventDefault() }}
      onTouchStart={e => { e.stopPropagation(); e.preventDefault() }}
      onTouchEnd={e => { e.stopPropagation(); e.preventDefault() }}
      onPointerDown={e => { e.stopPropagation(); e.preventDefault() }}>
      <div className="bottom-sheet"
        onClick={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}>

        <div className="sheet-handle" />
        <div className="sheet-header">
          <div>
            <div style={{ fontSize: 20 }}>
              {item.img} <span style={{ fontFamily: 'Prompt', fontWeight: 700 }}>{item.displayName || item.name}</span>
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
                ×
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
              ×
            </button>
          )}
        </div>

        <div className="sheet-body">
          {/* ── Info box ─────────────────────────────────── */}
          <div style={{ background: '#EFF6FF', borderRadius: 10, padding: 12, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: 'var(--txt2)' }}>Stock คงเหลือ{lockedWh ? ` · ${whName(lockedWh)}` : ''}</span>
              <span style={{ fontWeight: 700, fontFamily: 'Prompt' }}>{qty} {item.unitUse}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: 'var(--txt2)' }}>จำนวน Lot</span>
              <span style={{ fontWeight: 700 }}>{displayLots.length} Lot</span>
            </div>
            {warnCount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ fontWeight: 700, color: '#EA580C' }}>Lot ใกล้หมดอายุ</span>
                <span style={{ fontWeight: 700, color: '#EA580C' }}>{warnCount} Lot ⚠️</span>
              </div>
            )}
            {/* ⚠️ LOT drift — ยอด LOT ที่คลังนี้ไม่ตรงยอดจริง → ชี้ให้ Owner ไปกดซ่อมใน ตั้งค่า */}
            {lockedWh && (() => {
              const lotHere = lots.reduce((s, l) => {
                if (l.locationQty && typeof l.locationQty === 'object') return s + (Number(l.locationQty[lockedWh]) || 0)
                if (l.warehouseId === lockedWh) return s + (Number(l.inWarehouse) || 0)
                return s
              }, 0)
              if (Math.abs(lotHere - qty) < 0.001) return null
              return (
                <div style={{ marginTop: 6, padding: '6px 10px', background: '#FEF3C7',
                  border: '1px solid #FDE68A', borderRadius: 8, fontSize: 11, color: '#92400E', lineHeight: 1.5 }}>
                  ⚠️ ยอด LOT ที่{whName(lockedWh)} ({lotHere}) ไม่ตรงยอดจริง ({qty} {item.unitUse})
                  — ซ่อมได้ที่ ตั้งค่า → 🧩 ปรับ LOT ให้ตรงสต็อก
                </div>
              )
            })()}
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

          {/* ── เพิ่ม LOT + รวม LOT (Owner/Editor) ─────────── */}
          {canEdit && !addOpen && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {!mergeMode && (
                <button onClick={startAddLot}
                  style={{ flex: 1, padding: '10px 14px', border: '2px dashed var(--red)',
                    borderRadius: 12, background: 'var(--red-p)', color: 'var(--red)',
                    fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                  ➕ เพิ่ม LOT
                </button>
              )}
              {displayLots.length >= 2 && (
                <button onClick={toggleMergeMode}
                  style={{ flex: 1, padding: '10px 14px',
                    border: mergeMode ? '2px solid #0284C7' : '2px dashed #0284C7',
                    borderRadius: 12, background: mergeMode ? '#E0F2FE' : '#F0F9FF',
                    color: '#0284C7', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                  {mergeMode ? '✕ ยกเลิกโหมดรวม' : '🔀 รวม LOT'}
                </button>
              )}
            </div>
          )}

          {/* ── แผงรวม LOT ─────────────────────── */}
          {mergeMode && (() => {
            const selLots = mergeSel.map(id => lots.find(l => l.id === id)).filter(Boolean)
            const sumQty  = selLots.reduce((s, l) => s + getLotQty(l), 0)
            return (
              <div style={{ background: '#F0F9FF', border: '2px solid #7DD3FC',
                borderRadius: 12, padding: 14, marginBottom: 14 }}>
                <div style={{ fontWeight: 700, color: '#0369A1', fontSize: 13, marginBottom: 4 }}>
                  🔀 รวม LOT เป็นใบเดียว
                </div>
                <div style={{ fontSize: 11, color: '#0C4A6E', lineHeight: 1.5 }}>
                  แตะการ์ด LOT ด้านล่างเพื่อเลือก (อย่างน้อย 2 LOT · ต้องอยู่คลังเดียวกัน · เฉพาะ LOT แม่)
                  — ยอดจะถูกบวกรวม แล้ว LOT ที่เหลือถูกยุบทิ้ง
                </div>
                {selLots.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: '#0369A1' }}>
                    เลือกแล้ว {selLots.length} LOT · รวม {sumQty} {item.unitUse}
                  </div>
                )}
                {selLots.length >= 2 && (
                  <>
                    <div style={{ marginTop: 10, fontSize: 11, fontWeight: 700, color: '#0C4A6E' }}>
                      ใช้ข้อมูล (Lot No. / วันที่รับ / EXP) ของ:
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                      {selLots.map(l => (
                        <label key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8,
                          padding: '8px 10px',
                          background: mergePrimary === l.id ? '#E0F2FE' : 'var(--bg)',
                          border: `1.5px solid ${mergePrimary === l.id ? '#38BDF8' : 'var(--border)'}`,
                          borderRadius: 8, cursor: 'pointer', fontSize: 12 }}>
                          <input type="radio" checked={mergePrimary === l.id}
                            onChange={() => setMergePrimary(l.id)} />
                          <span style={{ fontWeight: 700 }}>LOT {getLotDisplay(l)}</span>
                          <span style={{ color: 'var(--txt3)', fontSize: 11 }}>
                            {getLotQty(l)} {item.unitUse} · EXP {formatDateDDMMYY(l.expDate) || '-'}
                          </span>
                        </label>
                      ))}
                    </div>
                    <button onClick={confirmMerge} disabled={saving}
                      style={{ width: '100%', marginTop: 10, padding: '10px 16px', border: 'none',
                        borderRadius: 10, background: saving ? 'var(--border2)' : '#0284C7',
                        color: '#fff', fontSize: 13, fontWeight: 700,
                        cursor: saving ? 'wait' : 'pointer' }}>
                      {saving ? '⏳ กำลังรวม...' : `✅ รวม ${selLots.length} LOT (${sumQty} ${item.unitUse})`}
                    </button>
                  </>
                )}
              </div>
            )
          })()}
          {addOpen && (
            <div style={{ background: '#F0FDF4', border: '2px solid #86EFAC',
              borderRadius: 12, padding: 14, marginBottom: 14,
              display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: '#15803D' }}>📦 เพิ่ม LOT ใหม่</span>
                <button onClick={() => { setAddOpen(false); setError('') }}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                    fontSize: 18, color: '#6B7280' }}>×</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <label style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>LOT No (auto · แก้ได้)</label>
                  <input value={addDraft.lotNo}
                    onChange={e => setAddDraft(d => ({ ...d, lotNo: e.target.value }))}
                    placeholder="AUTO-251128-1430"
                    style={{ width: '100%', padding: '6px 10px', borderRadius: 8,
                      border: '1.5px solid var(--border2)', fontSize: 13 }}/>
                </div>
                <div>
                  <label style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>
                    คลัง * {lockedWh && <span style={{ color: '#16A34A' }}>🔒 lock ตามหน้า</span>}
                  </label>
                  {lockedWh ? (
                    <div style={{ width: '100%', padding: '6px 10px', borderRadius: 8,
                      border: '1.5px solid #BBF7D0', background: '#F0FDF4',
                      fontSize: 13, fontWeight: 600, color: '#15803D',
                      display: 'flex', alignItems: 'center', gap: 6 }}>
                      🏪 {warehouses.find(w => w.id === lockedWh)?.name || lockedWh}
                    </div>
                  ) : (
                    <select value={addDraft.warehouseId}
                      onChange={e => setAddDraft(d => ({ ...d, warehouseId: e.target.value }))}
                      style={{ width: '100%', padding: '6px 10px', borderRadius: 8,
                        border: '1.5px solid var(--border2)', fontSize: 13 }}>
                      {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  )}
                </div>
                <div>
                  <label style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>📅 วันที่รับ *</label>
                  <input type="date" value={addDraft.receiveDate}
                    onChange={e => setAddDraft(d => ({ ...d, receiveDate: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', borderRadius: 8,
                      border: '1.5px solid var(--border2)', fontSize: 13 }}/>
                </div>
                <div>
                  <label style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>จำนวน ({item.unitUse}) *</label>
                  <input type="number" inputMode="decimal" value={addDraft.qty}
                    onChange={e => setAddDraft(d => ({ ...d, qty: e.target.value }))}
                    placeholder="0"
                    style={{ width: '100%', padding: '6px 10px', borderRadius: 8,
                      border: '1.5px solid var(--border2)', fontSize: 13, textAlign: 'right' }}/>
                </div>
                <div>
                  <label style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>📅 วันผลิต MFG</label>
                  <input type="date" value={addDraft.mfgDate}
                    onChange={e => setAddDraft(d => ({ ...d, mfgDate: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', borderRadius: 8,
                      border: '1.5px solid var(--border2)', fontSize: 13 }}/>
                </div>
                <div>
                  <label style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>📅 วันหมดอายุ EXP</label>
                  <input type="date" value={addDraft.expDate}
                    onChange={e => setAddDraft(d => ({ ...d, expDate: e.target.value }))}
                    style={{ width: '100%', padding: '6px 10px', borderRadius: 8,
                      border: '1.5px solid var(--border2)', fontSize: 13 }}/>
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '10px 12px', background: '#FFF7ED', border: '1px solid #FED7AA',
                borderRadius: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!addDraft.alsoAdjustStock}
                  onChange={e => setAddDraft(d => ({ ...d, alsoAdjustStock: e.target.checked }))}
                  style={{ marginTop: 2 }}/>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#92400E' }}>
                    ➕ เพิ่ม stock ตามจำนวน LOT ด้วย
                  </div>
                  <div style={{ fontSize: 10, color: '#B45309', marginTop: 2, lineHeight: 1.4 }}>
                    • <strong>ติ๊ก</strong> = LOT นี้คือของที่ <u>เพิ่งรับเข้ามา</u> → ระบบจะ +qty ในคลังให้<br/>
                    • <strong>ไม่ติ๊ก</strong> = บันทึก LOT ของที่ <u>มีอยู่แล้ว</u> (เช่นมาจากการปรับยอด หรือยังไม่มี LOT match)
                  </div>
                </div>
              </label>
              <button onClick={saveAddLot} disabled={saving}
                style={{ padding: '10px 16px', border: 'none', borderRadius: 10,
                  background: saving ? 'var(--border2)' : '#16A34A', color: '#fff',
                  fontSize: 13, fontWeight: 700, cursor: saving ? 'wait' : 'pointer' }}>
                {saving ? 'กำลังบันทึก...' : '💾 บันทึก LOT'}
              </button>
            </div>
          )}

          {/* ── LOT Cards ────────────────────────────────── */}
          {error && (
            <div style={{ background: '#FEE2E2', color: '#DC2626', borderRadius: 10,
              padding: '10px 14px', marginBottom: 12, fontSize: 13, fontWeight: 600 }}>
              ⚠️ {error}
            </div>
          )}

          {displayLots.length === 0 && !addOpen && (
            <div style={{ background: '#FFF7ED', border: '1px solid #FDE68A', borderRadius: 12,
              padding: '16px 14px', textAlign: 'center', color: '#92400E', fontSize: 13 }}>
              ยังไม่มี LOT สำหรับรายการนี้
              <div style={{ fontSize: 11, marginTop: 4, color: '#B45309' }}>
                กด ➕ ด้านบนเพื่อเพิ่ม LOT
              </div>
            </div>
          )}

          {displayLots.map((lot, idx) => {
            const isEditing = editingId === lot.id
            const exp       = getExpStatus(lot.expDate || '', thr)
            const isFamily  = !!lot._familyBd
            const bd        = isFamily ? lot._familyBd : getLocationBreakdown(lot)
            const docQty    = getLotQty(lot)              // ยอดของ doc นี้เอง — ใช้กับ แก้ไข/แบ่ง/ลบ
            const totalQty  = isFamily ? lot._familyTotal : docQty
            const lotDisplay = getLotDisplay(lot)
            const activeQty = Object.values(bd).reduce((s, v) => s + v, 0)
            // การ์ดรวมครอบครัว: เห็นคงเหลือครบทุกคลัง → ที่หาย = ใช้จริง (ไม่มีก้อน "โอนออก" เพราะโอนคือย้ายภายในครอบครัว)
            // การ์ดคลังเดียว: สมการ totalQty = คงเหลือ + used (field จริงจาก FIFO consume) + โอนออกไปคลังอื่น
            const usedQty = isFamily
              ? Math.max(0, totalQty - activeQty)
              : Math.min(Number(lot.used) || 0, Math.max(0, totalQty - activeQty))
            const transferredQty = isFamily ? 0 : Math.max(0, totalQty - activeQty - usedQty)

            const cardBg = exp.status === 'expired' || exp.status === 'danger' ? '#FFF5F5'
                         : exp.status === 'warning' ? '#FFFBEB'
                         : isEditing ? '#F0FDF4'
                         : 'var(--bg)'
            const cardBorder = exp.status === 'expired' || exp.status === 'danger' ? '1px solid #FECACA'
                             : exp.status === 'warning' ? '1px solid #FDE68A'
                             : isEditing ? '1px solid #86EFAC'
                             : '1px solid var(--border)'

            // 🔀 โหมดรวม LOT — เลือกได้เฉพาะ LOT แม่ที่คลังเดียวกับใบแรกที่เลือก
            const isMergeSel = mergeSel.includes(lot.id)
            const mergeWhLock = mergeSel.length > 0
              ? (lots.find(l => l.id === mergeSel[0])?.warehouseId || '') : null
            const isMergeable = mergeMode && !lot.parentLotId &&
              (mergeWhLock === null || isMergeSel || mergeWhLock === (lot.warehouseId || ''))

            return (
              <div key={lot.id}
                onClick={mergeMode && isMergeable ? () => toggleMergeSelect(lot) : undefined}
                style={{ marginBottom: 14,
                  background: isMergeSel ? '#F0F9FF' : cardBg,
                  borderRadius: 12, padding: 12,
                  border: isMergeSel ? '2px solid #38BDF8' : cardBorder,
                  opacity: mergeMode && !isMergeable ? 0.4 : 1,
                  cursor: mergeMode && isMergeable ? 'pointer' : 'default',
                  transition: 'all .2s' }}>

                {/* ── Card Header ─────────────────────── */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {mergeMode && isMergeable && (
                      <span style={{ fontSize: 16, lineHeight: 1 }}>{isMergeSel ? '☑️' : '⬜'}</span>
                    )}
                    <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14 }}>
                      LOT {lotDisplay}
                    </span>
                    {/* FIFO badge */}
                    {idx === 0 && (
                      <span style={{ background: '#DCFCE7', color: '#166534', fontSize: 9, fontWeight: 700,
                        padding: '2px 6px', borderRadius: 6 }}>FIFO ออกก่อน</span>
                    )}
                    {/* Sub-lot badge (เฉพาะการ์ดคลังเดียว — การ์ดรวมครอบครัวไม่ใช่ sub-lot) */}
                    {!isFamily && lot.parentLotId && (
                      <span style={{ background: '#EDE9FE', color: '#7C3AED', fontSize: 9, fontWeight: 700,
                        padding: '2px 6px', borderRadius: 6 }}>✂️ Sub-lot {lot.subLotSuffix || ''}</span>
                    )}
                    {/* Family badge — การ์ดนี้รวม LOT แม่+ลูกหลายคลัง */}
                    {isFamily && lot._familyCount > 1 && (
                      <span style={{ background: '#E0F2FE', color: '#0369A1', fontSize: 9, fontWeight: 700,
                        padding: '2px 6px', borderRadius: 6 }}>🔗 รวม {lot._familyCount} คลัง</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14 }}>
                      {totalQty} {item.unitUse}
                      {(() => {
                        // วงเล็บหน่วยใหญ่ (สีเทา) — เช่น "64 ถุง (4 ลัง)" · โชว์เมื่อถึงอย่างน้อย 1 หน่วยใหญ่
                        const f = parseConvFactor(item.unitConversion)
                        if (!(f > 1) || !item.unitBase || item.unitBase === item.unitUse || totalQty < f) return null
                        return (
                          <span style={{ fontWeight: 500, fontSize: 11, color: 'var(--txt3)', marginLeft: 4 }}>
                            ({formatStockQty(totalQty, item)})
                          </span>
                        )
                      })()}
                    </span>
                    {canEdit && !isEditing && !mergeMode && (
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
                  </>
                )}

                {/* ── Location breakdown chips ────────── */}
                {!isEditing && (
                  <LocationChips
                    bd={bd} usedQty={usedQty} transferredQty={transferredQty} totalQty={totalQty}
                    unitUse={item.unitUse}
                    whName={whName} whColor={whColor} whBg={whBg}
                  />
                )}

                {/* ── 🔗 LOT Family (Smart Link) — เฉพาะการ์ดคลังเดียว (การ์ดรวมมีข้อมูลครบแล้ว) ── */}
                {!isEditing && !isFamily && (() => {
                  // หา family: LOT แม่ + ลูกทั้งหมด (ใช้ lots ทั้งหมด ไม่ใช่ scoped — เพื่อเห็นว่าโอนไปคลังอื่นเท่าไร)
                  const rootId = lot.parentLotId || lot.id
                  const family = lots.filter(l =>
                    l.id === rootId || l.parentLotId === rootId
                  )
                  if (family.length <= 1) return null   // ไม่มี LOT ลูก/ไม่ใช่ลูก → ข้าม
                  const root      = family.find(l => l.id === rootId) || family[0]
                  const familyTotal = Number(root.totalQty) || getLotQty(root)
                  // breakdown ต่อคลัง (sum inWarehouse จากทุก LOT ใน family)
                  const perWh = {}
                  family.forEach(l => {
                    const wh = l.warehouseId || '__main__'
                    perWh[wh] = (perWh[wh] || 0) + (Number(l.inWarehouse) || 0)
                  })
                  const totalAlive = Object.values(perWh).reduce((s,v) => s+v, 0)
                  const totalUsed  = Math.max(0, familyTotal - totalAlive)
                  const isRoot = lot.id === rootId
                  return (
                    <div style={{ marginTop: 8, padding: '8px 10px', background: '#F0F9FF',
                      border: '1px solid #BAE6FD', borderRadius: 8, fontSize: 11 }}>
                      <div style={{ color: '#0369A1', fontWeight: 700, marginBottom: 4 }}>
                        🔗 LOT Family — รวมรับ {familyTotal} {item.unitUse}
                        {isRoot
                          ? <span style={{ background: '#FEF3C7', color: '#92400E', padding: '1px 6px', borderRadius: 4, marginLeft: 6, fontSize: 9 }}>👑 LOT แม่</span>
                          : <span style={{ background: '#EDE9FE', color: '#7C3AED', padding: '1px 6px', borderRadius: 4, marginLeft: 6, fontSize: 9 }}>🌿 LOT ลูก</span>}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 10 }}>
                        {Object.entries(perWh).map(([wh, q]) => {
                          if (q <= 0) return null
                          const isHere = wh === (lot.warehouseId || '__main__')
                          return (
                            <span key={wh} style={{
                              background: isHere ? '#DCFCE7' : '#FEE2E2',
                              color:      isHere ? '#15803D' : '#B91C1C',
                              border: `1px solid ${isHere ? '#86EFAC' : '#FECACA'}`,
                              borderRadius: 6, padding: '2px 8px', fontWeight: 700,
                            }}>
                              {isHere ? '🟢' : '🟠'} {whName(wh)}: {q}
                            </span>
                          )
                        })}
                        {totalUsed > 0 && (
                          <span style={{ background: '#F3F4F6', color: '#6B7280',
                            border: '1px solid #E5E7EB', borderRadius: 6, padding: '2px 8px',
                            fontWeight: 700 }}>
                            ⚪ ใช้ไป: {totalUsed}
                          </span>
                        )}
                      </div>
                      {!isRoot && lot.parentLotId && (
                        <div style={{ marginTop: 4, fontSize: 9, color: '#6B7280' }}>
                          ↳ มาจาก LOT แม่ #{lot.parentLotId.slice(-8)} (คลังกลาง)
                          {lot.transferRef && ` · ใบโอน ${lot.transferRef}`}
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* ── Edit Form ────────────────────────── */}
                {isEditing && !splitOpen && confirmDeleteId !== lot.id && (
                  <EditForm
                    draft={editDraft}
                    setDraft={setEditDraft}
                    lot={lot}
                    totalQty={docQty}
                    saving={saving}
                    isOwner={canManage}
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
                        <strong>LOT {getLotDisplay(lot)}</strong> · {docQty} {item.unitUse}
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
                    totalQty={docQty}
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
function LocationChips({ bd, usedQty, transferredQty = 0, totalQty, unitUse, whName, whColor, whBg }) {
  const locations = Object.entries(bd).filter(([, q]) => q > 0)
  if (locations.length === 0 && usedQty === 0 && transferredQty === 0) return null

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
        {transferredQty > 0 && Array.from({ length: Math.max(1, Math.round(transferredQty * scale)) }).map((_, i) => (
          <div key={`xfer-${i}`}
            style={{ width: 10, height: 10, borderRadius: '50%',
              background: '#DBEAFE', flexShrink: 0,
              border: '1.5px solid #93C5FD' }} />
        ))}
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
        {transferredQty > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#3B82F6' }} />
            <span style={{ fontSize: 10, color: '#2563EB', fontWeight: 600 }}>โอนออกแล้ว ({transferredQty})</span>
          </div>
        )}
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

/* ─────────────────────────────────────────────────────────────
   👓 ItemHistoryPopup — ประวัติย้อนหลังทุกเหตุการณ์ของวัตถุดิบ
   ดึงจาก stock_movements + cut_logs + waste_logs ทุกคลัง
───────────────────────────────────────────────────────────── */
function ItemHistoryPopup({ item, warehouses = [], currentScope = '', onClose }) {
  const [movements, setMovements] = useState([])
  const [cutLogs, setCutLogs] = useState([])
  const [wasteLogs, setWasteLogs] = useState([])
  const [balances, setBalances]   = useState([])  // ทุกคลังของ item
  const [transfers, setTransfers] = useState([])  // ใบโอนที่มี item นี้
  const [filter, setFilter] = useState('all') // all | cut | add | adjust | waste | transfer
  const [xBounce, setXBounce] = useState(false)
  // ใช้ scope ตามหน้าหลัก (ถ้ามี) — ไม่ให้ผู้ใช้สลับใน popup
  const scope = currentScope || 'all'
  function bounceX(e) {
    if (e) { e.stopPropagation(); e.preventDefault() }
    setXBounce(false)
    requestAnimationFrame(() => requestAnimationFrame(() => setXBounce(true)))
  }

  useEffect(() => {
    if (!item?.id) return
    const u1 = onSnapshot(
      query(collection(db, COL.STOCK_MOVEMENTS), where('itemId', '==', item.id)),
      snap => setMovements(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => {})
    const u2 = onSnapshot(collection(db, COL.CUT_STOCK_LOGS),
      snap => {
        const rows = []
        snap.docs.forEach(d => {
          const log = d.data()
          ;(log.items || []).forEach((it, idx) => {
            if (it.itemId === item.id) rows.push({ id: `${d.id}_${idx}`, log, it })
          })
        })
        setCutLogs(rows)
      }, () => {})
    const u3 = onSnapshot(
      query(collection(db, COL.WASTE_LOGS), where('itemId', '==', item.id)),
      snap => setWasteLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => {})
    const u4 = onSnapshot(
      query(collection(db, COL.STOCK_BALANCES), where('itemId', '==', item.id)),
      snap => setBalances(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => {})
    // โหลด transfers ทั้งหมดที่ status === 'received' แล้วกรองด้วย item.id ฝั่ง client
    const u5 = onSnapshot(collection(db, COL.TRANSFER_ORDERS),
      snap => {
        const rows = []
        snap.docs.forEach(d => {
          const tf = { id: d.id, ...d.data() }
          if (tf.status !== 'received') return
          ;(tf.items || []).forEach(it => {
            if (it.itemId === item.id) rows.push({ tf, it })
          })
        })
        setTransfers(rows)
      }, () => {})
    return () => { u1(); u2(); u3(); u4(); u5() }
  }, [item?.id])

  // ยอดรวมปัจจุบัน (ทุกคลัง) ในหน่วย unitUse
  const currentTotalQty = balances.reduce((s, b) => s + (Number(b.qty) || 0), 0)

  // Helper: convert raw qty (any unit) → qtyUse (smallest unit)
  const factor = (() => {
    const conv = item?.unitConversion || ''
    const m = conv.match(/=\s*([\d.]+)/)
    return m ? Number(m[1]) || 1 : (Number(item?.convBuyToUse) || 1)
  })()
  const toQtyUse = (q, unit) => qtyToUse(Math.abs(Number(q) || 0), unit, item)  // รองรับหน่วยหลายชั้น

  // ─── รวมเหตุการณ์ทั้งหมด ───
  // กฎ dedupe: stock_movements ที่ type=cut/waste จะถูก SKIP เพราะ cut_logs/waste_logs มีข้อมูลละเอียดกว่า
  const events = []

  // เตรียม set ของ "เวลา×คลัง×คน" ของเหตุการณ์จาก cut_logs/waste_logs
  // (ใช้กันซ้ำเผื่อ legacy stock_movement type ไม่ใช่ cut/waste)
  const dedupKeySet = new Set()
  cutLogs.forEach(({ log }) => {
    const ts = log.timestamp?.seconds || 0
    if (ts) dedupKeySet.add(`cut|${ts}|${log.warehouseId || ''}`)
  })
  wasteLogs.forEach(w => {
    const ts = w.timestamp?.seconds || 0
    if (ts) dedupKeySet.add(`waste|${ts}|${w.warehouseId || ''}`)
  })

  // lookup ใบโอน (Inv_transfers) ตาม tf.id — ใช้ createdBy/receivedBy ของจริงมาโชว์คู่กับ movement log เก่าที่ไม่มี field นี้
  const tfById = new Map(transfers.map(({ tf }) => [tf.id, tf]))

  // 1. stock_movements (รับ, โอน, ปรับยอด, สร้าง LOT)
  movements.forEach(m => {
    if (m.type === 'cut' || m.type === 'waste') return  // dedupe ชั้นแรก
    // dedupe ชั้น 2 — เวลา/คลัง ตรงกับ cut_logs/waste_logs → ข้าม
    const ts = m.timestamp?.seconds || 0
    if (ts && dedupKeySet.has(`cut|${ts}|${m.warehouseId || ''}`)) return
    if (ts && dedupKeySet.has(`waste|${ts}|${m.warehouseId || ''}`)) return
    const typeMap = {
      receive:           { icon: '📥', label: 'รับสินค้า',   color: '#16A34A', bg: '#DCFCE7', delta: +1 },
      transfer_send:     { icon: '🚚', label: 'นำส่งโอน',     color: '#0369A1', bg: '#E0F2FE', delta: -1 },
      transfer_recv:     { icon: '📦', label: 'รับโอน',       color: '#16A34A', bg: '#DCFCE7', delta: +1 },
      transfer_reverse:  { icon: '↩️', label: 'ย้อนการโอน',   color: '#9333EA', bg: '#F3E8FF', delta: +1 },
      adjust:            { icon: '⚖️', label: 'ปรับยอด',     color: '#1D4ED8', bg: '#DBEAFE',
                           delta: Number(m.qty) >= 0 ? +1 : -1 },
      adjust_add:        { icon: '⚖️', label: 'ปรับยอด',     color: '#1D4ED8', bg: '#DBEAFE', delta: +1 },
      adjust_remove:     { icon: '⚖️', label: 'ปรับยอด',     color: '#1D4ED8', bg: '#DBEAFE', delta: -1 },
      lot_init:          { icon: '🆕', label: 'สร้าง LOT',    color: '#0EA5E9', bg: '#E0F2FE', delta: +1 },
    }
    const meta = typeMap[m.type] || { icon: '📝', label: m.type || 'บันทึก', color: '#6B7280', bg: '#F3F4F6', delta: 0 }
    const whName = warehouses.find(w => w.id === m.warehouseId)?.name || m.warehouseId || ''
    // เลือกหน่วยแสดงที่ตรงกับ user input
    //   - ถ้า qty เป็นจำนวนเต็ม (≥1) → user ปรับใน unitBase (เช่น +2 แพ็ค) → ใช้ qty + unit
    //   - ถ้า qty เป็นเศษ (<1 หรือไม่ใช่ int) → user ปรับใน unitUse (เช่น +1 กระป๋อง) → ใช้ qtyUse + unitUse
    const absQty = Math.abs(Number(m.qty || 0))
    const absQtyUse = Math.abs(Number(m.qtyUse || 0))
    const qtyIsCleanInt = absQty >= 1 && Math.abs(absQty - Math.round(absQty)) < 0.001 && m.unit
    const hasUse = m.qtyUse != null && m.qtyUse !== 0 && m.unitUse
    let displayQ, displayU
    if (qtyIsCleanInt) {
      displayQ = absQty
      displayU = m.unit
    } else if (hasUse) {
      displayQ = absQtyUse
      displayU = m.unitUse
    } else {
      displayQ = absQty
      displayU = m.unit || item?.unitUse || ''
    }
    // qUse สำหรับ math running balance — ใช้ qtyUse เสมอ
    const qUse = hasUse ? absQtyUse : toQtyUse(m.qty || 0, m.unit)
    // ใบโอน — โชว์ทั้งผู้สร้างใบโอน (นำส่ง) และผู้กดรับ เพื่อรู้ว่าใครโอนใครรับ
    // ดึงจาก field ใหม่บน movement ก่อน · ถ้าไม่มี (log เก่า) → lookup จากใบโอนจริงใน Inv_transfers
    const isTransferMv = m.type === 'transfer_send' || m.type === 'transfer_recv'
    const relatedTf = isTransferMv && m.transferTfId ? tfById.get(m.transferTfId) : null
    const creatorNm  = m.createdByName  || relatedTf?.createdBy  || ''
    const receiverNm = m.receivedByName || relatedTf?.receivedBy || m.staffName || ''
    const staffName = (isTransferMv && creatorNm && receiverNm && creatorNm !== receiverNm)
      ? `${creatorNm} → ${receiverNm}`
      : (receiverNm || m.staffName || m.adjustBy || '-')
    // เวลานำส่ง (สร้างใบโอน) vs เวลารับ — movement.timestamp คือเวลากดรับจริงเสมอ
    const createdTs  = isTransferMv ? (relatedTf?.createdAt?.seconds || 0) : 0
    const receivedTs = isTransferMv ? (relatedTf?.receivedAt?.seconds || ts) : 0
    events.push({
      id: 'mv_' + m.id, ts, type: m.type, meta,
      qty: displayQ,
      qtyUse: qUse,
      sign: meta.delta >= 0 ? '+' : '−',
      delta: meta.delta * qUse,
      unit: displayU,
      whId: m.warehouseId || '',
      whName, staffName,
      createdTs, receivedTs,
      note: m.note || m.adjustReason || '',
    })
  })

  // 2. cut_logs (per-item entry inside parent log)
  cutLogs.forEach(({ id, log, it }) => {
    if (log.cancelled || it.cancelled) return
    const ts = log.timestamp?.seconds || 0
    const meta = { icon: '✂️', label: 'ตัดสต็อก', color: '#DB2777', bg: '#FDF2F8', delta: -1 }
    const whName = warehouses.find(w => w.id === log.warehouseId)?.name || log.warehouseId || ''
    const rawQ = it.qtyUse || it.qty || 0
    const qUse = toQtyUse(rawQ, it.unitUse || it.unit)
    events.push({
      id: 'cut_' + id, ts, type: 'cut', meta,
      qty: Number(rawQ),
      qtyUse: qUse,
      sign: '−',
      delta: -qUse,
      unit: it.unitUse || it.unit || '',
      whId: log.warehouseId || '',
      whName, staffName: log.staffName || '-',
      note: '',
    })
  })

  // 2b. transfer_orders (fallback) — สำหรับ TF ที่ไม่ได้ write stock_movements
  // ตรวจสอบจาก movements: ถ้ามี transfer_send หรือ transfer_recv ของ TF นี้แล้ว → skip
  const tfIdsInMovements = new Set(
    movements
      .filter(m => (m.type === 'transfer_send' || m.type === 'transfer_recv') && m.transferTfId)
      .map(m => m.transferTfId)
  )
  transfers.forEach(({ tf, it }) => {
    if (tfIdsInMovements.has(tf.id)) return  // มี movement แล้ว → skip
    const ts = tf.receivedAt?.seconds || tf.createdAt?.seconds || 0
    const itemMeta = item
    const factor = (() => {
      const conv = itemMeta?.unitConversion || ''
      const m = conv.match(/=\s*([\d.]+)/)
      return m ? Number(m[1]) || 1 : 1
    })()
    // ยอดที่ขยับจริง — ใบที่รับแล้วใช้ receivedQty (รับไม่ครบ/0) · ใบเก่า/ยังไม่รับ → it.qty
    const movedRaw = (tf.status === 'received' && it.receivedQty != null)
      ? (parseFloat(it.receivedQty) || 0)
      : (parseFloat(it.qty) || 0)
    if (movedRaw <= 0) return   // รับ 0 / ไม่ได้โอนมา → ไม่ขึ้นในประวัติ
    const qtyIn = movedRaw
    const qUse = qtyToUse(qtyIn, it.unit, itemMeta)
    const fromMeta = { icon: '🚚', label: 'นำส่งโอน', color: '#0369A1', bg: '#E0F2FE', delta: -1 }
    const toMeta   = { icon: '📦', label: 'รับโอน',  color: '#16A34A', bg: '#DCFCE7', delta: +1 }
    // ใบโอน — โชว์ทั้งผู้สร้างใบโอน (นำส่ง) และผู้กดรับ เพื่อรู้ว่าใครโอนใครรับ
    const tfStaffName = (tf.receivedBy && tf.createdBy && tf.receivedBy !== tf.createdBy)
      ? `${tf.createdBy} → ${tf.receivedBy}`
      : (tf.receivedBy || tf.createdBy || '-')
    const createdTs  = tf.createdAt?.seconds || 0
    const receivedTs = tf.receivedAt?.seconds || 0
    // ฝั่งต้นทาง — ลด
    events.push({
      id: `tf_s_${tf.id}`, ts, type: 'transfer_send', meta: fromMeta,
      qty: qtyIn, qtyUse: qUse,
      sign: '−', delta: -qUse,
      unit: it.unit || '',
      whId: tf.fromWarehouseId || '',
      whName: tf.fromWarehouseName || warehouses.find(w => w.id === tf.fromWarehouseId)?.name || '',
      staffName: tfStaffName,
      createdTs, receivedTs,
      note: `ใบโอน ${tf.tfRef || tf.id} → ${tf.toWarehouseName || ''}`,
    })
    // ฝั่งปลายทาง — เพิ่ม
    events.push({
      id: `tf_r_${tf.id}`, ts, type: 'transfer_recv', meta: toMeta,
      qty: qtyIn, qtyUse: qUse,
      sign: '+', delta: +qUse,
      unit: it.unit || '',
      whId: tf.toWarehouseId || '',
      whName: tf.toWarehouseName || warehouses.find(w => w.id === tf.toWarehouseId)?.name || '',
      staffName: tfStaffName,
      createdTs, receivedTs,
      note: `ใบโอน ${tf.tfRef || tf.id} ← ${tf.fromWarehouseName || ''}`,
    })
  })

  // 3. waste_logs
  wasteLogs.forEach(w => {
    if (w.cancelled) return
    const ts = w.timestamp?.seconds || 0
    const meta = { icon: '🗑️', label: w.type === 'closing' ? 'ของเสียปิดร้าน' : 'ของเสียระหว่างวัน',
      color: '#D97706', bg: '#FFF7ED', delta: -1 }
    const whName = warehouses.find(w2 => w2.id === w.warehouseId)?.name || w.warehouseId || ''
    const rawQ = w.qty || 0
    const qUse = toQtyUse(rawQ, w.unit)
    events.push({
      id: 'ws_' + w.id, ts, type: 'waste', meta,
      qty: Number(rawQ),
      qtyUse: qUse,
      sign: '−',
      delta: -qUse,
      unit: w.unit || '',
      whId: w.warehouseId || '',
      whName, staffName: w.staffName || '-',
      note: w.note || '',
    })
  })

  // ─── Running balance แยกตามคลัง ───
  // คำนวณ balance ของแต่ละ event ในแต่ละ warehouseId แยกกัน
  //   balance = ยอดของคลังนั้นหลังเหตุการณ์นี้
  //   เริ่มจากยอดจริง (balances) แล้วถอยหลัง
  const balByWh = {}
  balances.forEach(b => { balByWh[b.warehouseId] = Number(b.qty) || 0 })
  const eventsByWh = {}
  events.forEach(e => { (eventsByWh[e.whId] = eventsByWh[e.whId] || []).push(e) })
  Object.entries(eventsByWh).forEach(([whId, arr]) => {
    const sortedDesc = [...arr].sort((a, b) => b.ts - a.ts)
    let bal = balByWh[whId] || 0
    sortedDesc.forEach(e => {
      e.balance = bal
      bal = bal - (e.delta || 0)
    })
  })
  const displayUnit = item?.unitUse || ''
  // ยอดปัจจุบันของ scope ที่เลือก
  const scopeQty = scope === 'all' ? currentTotalQty : (balByWh[scope] || 0)
  const scopeName = scope === 'all' ? 'ทุกคลัง'
    : warehouses.find(w => w.id === scope)?.name || scope

  // Filter + sort สำหรับ display
  const filtered = events
    .filter(e => {
      // กรอง scope (คลัง) ก่อน
      if (scope !== 'all' && e.whId !== scope) return false
      if (filter === 'all') return true
      if (filter === 'cut')      return e.type === 'cut'
      if (filter === 'add')      return e.type === 'receive'   // เฉพาะรับสินค้า (ซื้อเข้าคลังกลาง)
      if (filter === 'adjust')   return ['adjust', 'adjust_add', 'adjust_remove'].includes(e.type)
      if (filter === 'waste')    return e.type === 'waste'
      if (filter === 'transfer') return ['transfer_send', 'transfer_recv', 'transfer_reverse'].includes(e.type)
      return true
    })
    .sort((a, b) => b.ts - a.ts)

  // ปรับ FILTERS counts ให้สะท้อนตาม scope
  const scopedEvents = scope === 'all' ? events : events.filter(e => e.whId === scope)
  const FILTERS_SCOPED = [
    { id: 'all',      label: 'ทั้งหมด',  count: scopedEvents.length },
    { id: 'add',      label: '📥 รับเข้า', count: scopedEvents.filter(e => e.type === 'receive').length },
    { id: 'cut',      label: '✂️ ตัด',    count: scopedEvents.filter(e => e.type === 'cut').length },
    { id: 'adjust',   label: '⚖️ ปรับ',   count: scopedEvents.filter(e => ['adjust','adjust_add','adjust_remove'].includes(e.type)).length },
    { id: 'transfer', label: '🚚 โอน',    count: scopedEvents.filter(e => ['transfer_send','transfer_recv','transfer_reverse'].includes(e.type)).length },
    { id: 'waste',    label: '🗑️ เสีย',   count: scopedEvents.filter(e => e.type === 'waste').length },
  ]

  // (FILTERS_SCOPED ถูกคำนวณข้างบนแล้ว — sensitive ต่อ scope)
  // List of warehouse chips
  const whIdsWithActivity = Array.from(new Set([
    ...events.map(e => e.whId).filter(Boolean),
    ...balances.map(b => b.warehouseId).filter(Boolean),
  ]))
  const whChips = warehouses
    .filter(w => whIdsWithActivity.includes(w.id))
    .sort((a, b) => {
      // main ก่อน, แล้ว branch
      const am = (a.type === 'main' || a.isMain) ? 0 : 1
      const bm = (b.type === 'main' || b.isMain) ? 0 : 1
      if (am !== bm) return am - bm
      return (a.name || '').localeCompare(b.name || '', 'th')
    })

  function fmtTime(ts) {
    if (!ts) return '-'
    const d = new Date(ts * 1000)
    const dd = String(d.getDate()).padStart(2,'0')
    const mm = String(d.getMonth()+1).padStart(2,'0')
    const yy = (d.getFullYear() + 543).toString().slice(-2)
    const hh = String(d.getHours()).padStart(2,'0')
    const mn = String(d.getMinutes()).padStart(2,'0')
    return `${dd}/${mm}/${yy} ${hh}:${mn}`
  }
  function fmtDateOnly(ts) {
    if (!ts) return '-'
    const d = new Date(ts * 1000)
    const dd = String(d.getDate()).padStart(2,'0')
    const mm = String(d.getMonth()+1).padStart(2,'0')
    const yy = (d.getFullYear() + 543).toString().slice(-2)
    return `${dd}/${mm}/${yy}`
  }
  function fmtTimeOnly(ts) {
    if (!ts) return null
    const d = new Date(ts * 1000)
    const hh = String(d.getHours()).padStart(2,'0')
    const mn = String(d.getMinutes()).padStart(2,'0')
    return `${hh}:${mn}`
  }
  // ใบโอน — โชว์เวลาส่ง/เวลารับคู่กัน เช่น "12:57 / 14:51 (ที่รับ)"
  function fmtTransferTime(e) {
    const isTf = e.type === 'transfer_send' || e.type === 'transfer_recv'
    const t1 = isTf ? fmtTimeOnly(e.createdTs) : null
    const t2 = isTf ? fmtTimeOnly(e.receivedTs) : null
    if (t1 && t2 && t1 !== t2) return `${fmtDateOnly(e.ts)} ${t1} / ${t2} (ที่รับ)`
    return fmtTime(e.ts)
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
          border: '1.5px solid rgba(29,78,216,.3)',
          boxShadow: '0 12px 40px rgba(0,0,0,.22), 0 0 0 4px rgba(29,78,216,.06)' }}>
        {/* Sticky Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8,
          padding: '14px 16px', borderBottom: '1px solid #F3F4F6',
          background: '#fff', position: 'sticky', top: 0, zIndex: 2 }}>
          <span style={{ fontSize: 20 }}>👓</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              ประวัติ — {item?.displayName || item?.name}
            </div>
            <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 1,
              display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{scopedEvents.length} เหตุการณ์ · {scopeName}</span>
              <span style={{ background: '#DCFCE7', color: '#15803D', fontWeight: 700,
                borderRadius: 99, padding: '1px 8px', fontSize: 10 }}>
                ยอด {scopeQty.toLocaleString('th-TH', { maximumFractionDigits: 2 })} {displayUnit}
              </span>
            </div>
          </div>
          <button onClick={onClose} aria-label="ปิด" className="popup-x-btn"
            onAnimationEnd={() => setXBounce(false)}
            style={{ animation: xBounce ? 'xBounce 0.45s ease' : 'none' }}>×</button>
        </div>

        {/* Filter pills — 3 col × 2 row grid (สวย เท่ากันหมด) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6,
          padding: '10px 12px', borderBottom: '1px solid #F3F4F6' }}>
          {FILTERS_SCOPED.map(f => {
            const active = filter === f.id
            return (
              <button key={f.id} onClick={() => setFilter(f.id)}
                style={{ border: active ? '1.5px solid #1D4ED8' : '1px solid #E5E7EB',
                  borderRadius: 10, padding: '8px 10px',
                  fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  background: active ? '#1D4ED8' : '#fff',
                  color: active ? '#fff' : '#374151',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 4, transition: 'all .15s', whiteSpace: 'nowrap',
                  boxShadow: active ? '0 2px 6px rgba(29,78,216,.25)' : '0 1px 2px rgba(0,0,0,.04)' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.label}</span>
                <span style={{ background: active ? 'rgba(255,255,255,.22)' : '#F3F4F6',
                  color: active ? '#fff' : '#6B7280',
                  borderRadius: 99, padding: '1px 7px', fontSize: 10, flexShrink: 0,
                  fontVariantNumeric: 'tabular-nums' }}>
                  {f.count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Event list */}
        <div style={{ overflow: 'auto', flex: 1, padding: 12 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 12 }}>
              ไม่มีประวัติเหตุการณ์
            </div>
          ) : filtered.map(e => (
            <div key={e.id} style={{ display: 'flex', gap: 10, padding: '10px 0',
              borderBottom: '1px solid #F3F4F6', alignItems: 'flex-start' }}>
              <div style={{ width: 32, height: 32, borderRadius: 10, background: e.meta.bg,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, flexShrink: 0 }}>
                {e.meta.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: e.meta.color,
                    background: e.meta.bg, borderRadius: 5, padding: '1px 7px' }}>
                    {e.meta.label}
                  </span>
                  {e.whName && (
                    <span style={{ fontSize: 10, color: '#6B7280',
                      background: '#F3F4F6', borderRadius: 5, padding: '1px 6px' }}>
                      🏪 {e.whName}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                  👤 <b style={{ color: '#374151' }}>{e.staffName}</b>
                  <span style={{ marginLeft: 8 }}>🕐 {fmtTransferTime(e)}</span>
                </div>
                {e.note && (
                  <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2,
                    fontStyle: 'italic' }}>
                    {e.note}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
                flexShrink: 0, minWidth: 88 }}>
                <span style={{ fontSize: 13, fontWeight: 700,
                  color: e.sign === '+' ? '#16A34A' : e.sign === '−' ? '#DC2626' : '#1C1C1E' }}>
                  {e.sign}{e.qty} {e.unit}
                </span>
                <span style={{ fontSize: 10, color: '#6B7280', marginTop: 2,
                  background: '#F3F4F6', borderRadius: 5, padding: '1px 6px', fontWeight: 700 }}>
                  คงเหลือ {(e.balance ?? 0).toLocaleString('th-TH', { maximumFractionDigits: 2 })} {displayUnit}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
