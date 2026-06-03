import { useState, useEffect, useCallback } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, serverTimestamp } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { Modal } from '../components/Modal'
import { Toast } from '../components/Toast'
import { useSession } from '../hooks/useSession'
import { useOnline }  from '../hooks/useOnline'
import { beepClick, beepSuccess, beepAdd, beepRemove } from '../utils/audio'
import { toDateKey, toThaiTime } from '../utils/formatDate'
import { COL } from '../constants/collections'
import { cutStock } from '../utils/cutStock'
import { formatStockQty, balanceId } from '../utils/unit'

const CATS = [
  { id: 'fav',        name: 'ของฉัน',    emoji: '⭐' },
  { id: 'all',        name: 'ทั้งหมด',   emoji: '🔍' },
  { id: 'แยม',       name: 'แยม',        emoji: '🍓' },
  { id: 'ผลไม้',     name: 'ผลไม้',      emoji: '🍋' },
  { id: 'ไซรัป',     name: 'ไซรัป',      emoji: '🍯' },
  { id: 'ท็อปปิ้ง',  name: 'ท็อปปิ้ง',  emoji: '💎' },
  { id: 'วัตถุดิบ',  name: 'วัตถุดิบ',   emoji: '🥛' },
  { id: 'บรรจุภัณฑ์', name: 'บรรจุ',    emoji: '🥤' },
  { id: 'อื่นๆ', name: 'อื่นๆ', emoji: '🔖' },
]

export default function CutStock() {
  const { name, phone, isEditor } = useSession()
  const online = useOnline()
  const canEdit = isEditor() && online   // ❌ offline → ห้ามแก้ไข
  const FAVES_KEY = `fav_${phone}`

  const [loading, setLoading] = useState(true)
  const [cat, setCat] = useState('all')
  const [search, setSearch] = useState('')
  const [items, setItems] = useState([])
  const [balances, setBalances] = useState([])
  const [templates, setTemplates] = useState([])
  const [warehouses, setWarehouses] = useState([])
  const [staffList, setStaffList] = useState([])
  const [cart, setCart] = useState({})
  const [faves, setFaves] = useState(() => new Set(JSON.parse(localStorage.getItem(FAVES_KEY) || '[]')))
  const [cartOpen, setCartOpen] = useState(false)
  const [patternOpen, setPatternOpen] = useState(false)
  const [shopWH, setShopWH] = useState('')
  const [selectedStaff, setSelectedStaff] = useState(name)
  const [toast, setToast] = useState('')
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [cutNote, setCutNote] = useState('')

  // Items, templates, warehouses — ไม่ขึ้นกับ warehouse ที่เลือก
  useEffect(() => {
    const u1 = onSnapshot(collection(db, COL.ITEMS), snap => { setItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setLoading(false) })
    const u3 = onSnapshot(collection(db, COL.QUICK_TEMPLATES), snap => setTemplates(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0))))
    const u4 = onSnapshot(collection(db, COL.WAREHOUSES), snap => {
      const whs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(w => w.active !== false)
      setWarehouses(whs)
      if (!shopWH && whs.length > 0) {
        const shop = whs.find(w => w.type === 'shop' || w.isShop === true)
          || whs.find((_, i) => i > 0)
          || whs[0]
        setShopWH(shop.id)
      }
    })
    return () => { u1(); u3(); u4() }
  }, [])

  // Stock balances — filter เฉพาะ warehouse ที่เลือก ลด reads ~50%
  useEffect(() => {
    if (!shopWH) return
    const q = query(collection(db, COL.STOCK_BALANCES), where('warehouseId', '==', shopWH))
    const unsub = onSnapshot(q, snap => setBalances(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
    return () => unsub()
  }, [shopWH])

  function getStock(itemId) {
    const total = balances.filter(b => b.itemId === itemId && b.warehouseId === shopWH)
      .reduce((s, b) => s + (b.qty || 0), 0)
    return total
  }

  function toggleFav(itemId) {
    setFaves(prev => {
      const next = new Set(prev)
      next.has(itemId) ? next.delete(itemId) : next.add(itemId)
      localStorage.setItem(FAVES_KEY, JSON.stringify([...next]))
      return next
    })
  }

  function addItem(item) {
    beepAdd()
    setCart(c => ({ ...c, [item.id]: (c[item.id] || 0) + 1 }))
  }

  function setQty(itemId, qty) {
    if (qty <= 0) {
      setCart(c => {
        const n = { ...c }
        delete n[itemId]
        // ถ้าตะกร้าว่าง → ปิด confirm modal
        if (Object.keys(n).length === 0) setCartOpen(false)
        return n
      })
    } else {
      setCart(c => ({ ...c, [itemId]: qty }))
    }
  }

  function applyTemplate(tpl) {
    beepSuccess()
    const next = { ...cart }
    tpl.items.forEach(ti => {
      next[ti.itemId] = (next[ti.itemId] || 0) + ti.qty
    })
    setCart(next)
  }

  const cartCount = Object.values(cart).reduce((s, v) => s + v, 0)
  const cartItems = Object.entries(cart).filter(([, v]) => v > 0).map(([id, qty]) => ({
    item: items.find(i => i.id === id), qty
  })).filter(r => r.item)

  const cartByCategory = cartItems.reduce((acc, { item, qty }) => {
    const cat = item.category || 'อื่นๆ'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push({ item, qty })
    return acc
  }, {})

  // Pre-cut warnings (เปรียบเทียบใน unitUse — qty ใน cart ก็คือ unitUse อยู่แล้ว)
  const warnings = cartItems.filter(({ item, qty }) => {
    const stock = getStock(item.id)
    const bal   = balances.find(b => b.itemId === item.id && b.warehouseId === shopWH)
    const minQ  = bal?.minQty || 0
    return (stock - qty) < minQ
  })

  async function confirmCut() {
    if (cartItems.length === 0 || confirmLoading) return
    setConfirmLoading(true)
    if (warehouses.find(w => w.id === shopWH)?.type === 'main' && !cutNote.trim()) {
      setToast('⚠️ กรุณาระบุหมายเหตุ เนื่องจากตัดจากคลังกลาง')
      setConfirmLoading(false)
      return
    }
    try {
      const shopName = warehouses.find(w => w.id === shopWH)?.name || ''
      const result = await cutStock({
        cuts: cartItems.map(({ item, qty }) => ({
          itemId: item.id, itemName: item.name, img: item.img || '📦',
          qtyUse: qty, item, costPerUnit: item.unitPrice || 0,
        })),
        staffPhone: phone,
        staffName: selectedStaff,
        shopName,
        warehouseId: shopWH,
        note: cutNote || '',
      })

      beepSuccess()
      const count = cartItems.length
      setCart({})
      setCutNote('')
      setCartOpen(false)

      // Auto Alert Toast — แสดงตามสถานะ stock หลังตัด
      const low = result?.lowItems || []
      if (low.length === 0) {
        setToast(`✅ ตัดสต็อก ${count} รายการเรียบร้อย`)
      } else {
        const outs = low.filter(l => l.status === 'out')
        const lows = low.filter(l => l.status === 'low')
        // Queue toasts (แสดงทีละอันด้วย setTimeout)
        setToast(`✅ ตัดสต็อก ${count} รายการเรียบร้อย`)
        if (outs.length) {
          setTimeout(() => {
            setToast(`🔴 หมดสต็อก: ${outs.map(o => o.itemName).join(', ')}`)
          }, 2200)
        }
        if (lows.length) {
          setTimeout(() => {
            const msg = lows.length === 1
              ? `🟡 ${lows[0].itemName} เหลือ ${lows[0].qty} ${lows[0].unit} (min ${lows[0].minQty})`
              : `🟡 Stock ต่ำ ${lows.length} รายการ: ${lows.map(l => l.itemName).join(', ')}`
            setToast(msg)
          }, outs.length ? 4400 : 2200)
        }
      }
    } catch (e) {
      console.error('[cutStock]', e)
      setToast('❌ ' + (e.message || 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง'))
    } finally {
      setConfirmLoading(false)
    }
  }

  const filteredItems = items.filter(i => {
    // ซ่อน item ที่ถูกปิดสำหรับ warehouse นี้
    if (shopWH && i.visibleIn?.[shopWH] === false) return false
    // search match — บน displayName / name (case-insensitive, Thai-friendly)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      const name = (i.displayName || i.name || '').toLowerCase()
      if (!name.includes(q)) return false
    }
    if (cat === 'fav' && !search.trim()) return faves.has(i.id)
    if (cat !== 'all' && cat !== 'fav' && !search.trim()) return i.category === cat
    return true
  }).sort((a, b) => {
    // เรียงตาม sortOrder (จาก Settings → "ลากเพื่อเรียงลำดับ")
    const oa = a.sortOrder ?? 999
    const ob = b.sortOrder ?? 999
    if (oa !== ob) return oa - ob
    return (a.name || '').localeCompare(b.name || '', 'th')
  })

  return (
    <div className="page-pad">
      {toast && <Toast message={toast} onDone={() => setToast('')} />}

      {loading && (
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'48px 0',gap:12}}>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          <div style={{width:40,height:40,borderRadius:'50%',border:'3px solid #F3F4F6',borderTopColor:'#E31E24',animation:'spin .7s linear infinite'}}/>
          <div style={{fontSize:13,fontWeight:700,color:'#9CA3AF'}}>กำลังโหลด...</div>
        </div>
      )}

      {/* Viewer banner */}
      {!canEdit && (
        <div style={{ margin: '0 0 8px', padding: '8px 14px', background: '#EFF6FF',
          border: '1.5px solid #BFDBFE', borderRadius: 12, display: 'flex', alignItems: 'center',
          gap: 8, fontSize: 13, color: '#1E40AF', fontWeight: 600 }}>
          <span>👁️</span>
          <span>Viewer Mode — ดูข้อมูลได้เท่านั้น ไม่สามารถตัดสต็อกได้</span>
        </div>
      )}

      {/* Sub-header */}
      <div className="page-subbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="subbar-title">ตัดสต็อก</span>
          <button style={{ border: '1.5px solid var(--border2)', borderRadius: 20, padding: '3px 10px',
            fontSize: 12, fontWeight: 700, background: 'var(--surf2)', cursor: 'pointer' }}
            onClick={() => {
              const next = warehouses[(warehouses.findIndex(w => w.id === shopWH) + 1) % (warehouses.length || 1)]
              if (next) setShopWH(next.id)
            }}>
            🏪 {warehouses.find(w => w.id === shopWH)?.name || 'เลือกสาขา'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}
            onClick={() => setPatternOpen(true)}>📊</button>
          {canEdit && (
            <button onClick={() => cartCount > 0 && setCartOpen(true)}
              title={cartCount > 0 ? 'กดเพื่อยืนยันตัดสต็อก' : 'ตะกร้าว่าง'}
              style={{
                background: cartCount > 0 ? 'var(--red)' : 'transparent',
                border: cartCount > 0 ? '2px solid var(--red-d)' : '2px solid transparent',
                borderRadius: 12,
                padding: cartCount > 0 ? '6px 12px' : '6px',
                fontSize: 18,
                cursor: cartCount > 0 ? 'pointer' : 'default',
                position: 'relative',
                transition: 'all .15s',
                boxShadow: cartCount > 0 ? '0 2px 8px rgba(227,30,36,0.35)' : 'none',
                animation: cartCount > 0 ? 'cartPulse 1.6s ease-in-out infinite' : 'none',
              }}>
              <span style={{ filter: cartCount > 0 ? 'grayscale(0) brightness(1.5)' : 'none' }}>🛒</span>
              {cartCount > 0 && (
                <span style={{ position: 'absolute', top: -6, right: -6, background: '#fff',
                  color: 'var(--red)', borderRadius: '50%', width: 18, height: 18, fontSize: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
                  border: '2px solid var(--red-d)' }}>
                  {cartCount}
                </span>
              )}
            </button>
          )}
        </div>
        <style>{`@keyframes cartPulse{
          0%,100%{box-shadow:0 2px 8px rgba(227,30,36,0.35)}
          50%{box-shadow:0 2px 16px rgba(227,30,36,0.7)}
        }`}</style>
      </div>

      {/* Search */}
      <div style={{ padding: '0 1rem', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="search-wrap" style={{ margin: 0, flex: 1 }}>
          <span className="search-icon">🔍</span>
          <input className="search-input" placeholder="ค้นหาวัตถุดิบที่จะตัดสต็อก..."
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')} title="ล้าง">✕</button>
          )}
        </div>
        {search && (
          <span style={{ fontSize: 12, color: 'var(--txt3)', whiteSpace: 'nowrap', fontWeight: 600 }}>
            {filteredItems.length} รายการ
          </span>
        )}
      </div>

      {/* Quick templates */}
      {templates.length > 0 && (
        <div style={{ display: 'flex', gap: 8, overflow: 'auto', padding: '0 1rem', scrollbarWidth: 'none' }}>
          {templates.map(tpl => (
            <button key={tpl.id} onClick={() => applyTemplate(tpl)}
              style={{ flexShrink: 0, background: 'var(--surf)', border: '1.5px solid var(--border2)',
                borderRadius: 12, padding: '7px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 5 }}>
              {tpl.icon} {tpl.name}
              <span style={{ fontSize: 11, color: 'var(--txt3)' }}>{tpl.items?.length} รายการ</span>
            </button>
          ))}
        </div>
      )}

      {/* Sidebar + POS Grid */}
      <div style={{ display: 'flex', gap: 0, margin: '0 1rem', borderRadius: 14,
        border: '1px solid var(--border)', overflow: 'hidden', background: 'var(--surf)' }}>

        {/* Left: category sidebar */}
        <div className="pos-sidebar" style={{ flexShrink: 0, overflowY: 'auto', background: 'var(--bg)',
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

        {/* Right: POS cards */}
        <div style={{ flex: 1, overflowY: 'auto', maxHeight: 'calc(100vh - 280px)', padding: 8 }}>
          {filteredItems.length === 0 && cat === 'fav' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              height: 200, gap: 10, color: 'var(--txt3)' }}>
              <span style={{ fontSize: 36 }}>⭐</span>
              <div style={{ fontSize: 14, fontWeight: 600 }}>ยังไม่มีรายการโปรด</div>
              <div style={{ fontSize: 12 }}>กดดาว ☆ บนสินค้าเพื่อเพิ่มเข้า "ของฉัน"</div>
            </div>
          )}
          {filteredItems.length === 0 && cat !== 'fav' && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: 120, color: 'var(--txt3)', fontSize: 13 }}>
              ไม่มีสินค้าในหมวดนี้
            </div>
          )}
          <div className="pos-grid" style={{ margin: 0 }}>
            {filteredItems.map(item => {
              const qty = cart[item.id] || 0
              const stock = getStock(item.id)
              const isOut = stock <= 0
              return (
                <div key={item.id} className={`pos-card${qty > 0 ? ' selected' : ''}${isOut ? ' out-of-stock' : ''}${!canEdit ? ' viewer-lock' : ''}`}
                  onClick={() => canEdit && !isOut && addItem(item)}>
                  {qty > 0 && <span className="pos-qty-badge">{qty}</span>}
                  <button className="pos-fav" onClick={e => { e.stopPropagation(); toggleFav(item.id) }}>
                    {faves.has(item.id) ? '⭐' : '☆'}
                  </button>
                  <div className="pos-emoji">{item.img || '📦'}</div>
                  <div className="pos-name">{item.displayName || item.name}</div>
                  <div className="pos-stock">เหลือ {formatStockQty(stock, item)}</div>
                  {(() => {
                    const u = item.unitUse || item.unitBase || ''
                    const fmtN = n => Number.isInteger(n) ? n : Number(Number(n).toFixed(2))
                    const f = formatStockQty(stock, item)
                    const s = `${fmtN(stock)} ${u}`
                    const showSub = u && f !== s
                    // Always reserve space (height 14px) so steppers stay aligned across cards
                    return (
                      <div style={{ fontSize: 10, color: 'var(--txt3)', height: 16, lineHeight: '16px', marginBottom: 4, textAlign: 'center', visibility: (u && f !== s) ? 'visible' : 'hidden' }}>
                        {showSub ? `(รวม ${fmtN(stock)} ${u})` : ' '}
                      </div>
                    )
                  })()}
                  {canEdit && (
                    <div className="pos-counter" onClick={e => e.stopPropagation()}>
                      <button className="pos-btn minus" onClick={() => { if (qty > 0) { beepRemove(); setQty(item.id, qty - 1) } }}>−</button>
                      <span className="pos-qty-num">{qty}</span>
                      <button className="pos-btn plus" onClick={() => { beepAdd(); setQty(item.id, qty + 1) }}>+</button>
                    </div>
                  )}
                  <div className="pos-unit">{item.unitUse}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Cart confirm popup */}
      {cartOpen && (
        <div className="modal-backdrop"
          onClick={e => { e.stopPropagation(); e.preventDefault() }}
          onTouchStart={e => { e.stopPropagation(); e.preventDefault() }}
          onTouchEnd={e => { e.stopPropagation(); e.preventDefault() }}
          onPointerDown={e => { e.stopPropagation(); e.preventDefault() }}>
          <div className="bottom-sheet confirm-sheet"
            onClick={e => e.stopPropagation()}
            onTouchStart={e => e.stopPropagation()}
            onTouchEnd={e => e.stopPropagation()}
            onPointerDown={e => e.stopPropagation()}
            style={{ maxHeight: '88svh', display: 'flex', flexDirection: 'column' }}>
            <div className="sheet-handle" />

            {/* Header compact */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 16px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Snowking mascot animation */}
                <span className="scissors-spin" style={{ fontSize: 24, lineHeight: 1 }}>✂️</span>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--txt1)' }}>ยืนยันตัดสต็อก</div>
                  <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                    {warehouses.find(w => w.id === shopWH)?.name} · {new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
              <button className="sheet-close" onClick={() => !confirmLoading && setCartOpen(false)}>✕</button>
            </div>

            <div className="sheet-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0 16px 8px' }}>

              {/* Staff selector — compact inline */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
                background: 'var(--bg)', borderRadius: 10, padding: '8px 12px' }}>
                <span style={{ fontSize: 11, color: 'var(--txt3)', flexShrink: 0 }}>👤 โดย</span>
                <select className="fi" style={{ flex: 1, fontSize: 13, padding: '4px 8px', border: 'none',
                  background: 'transparent', fontWeight: 600 }}
                  value={selectedStaff} onChange={e => setSelectedStaff(e.target.value)}>
                  <option value={name}>{name}</option>
                  {staffList.map(s => <option key={s.phone} value={s.name}>{s.name}</option>)}
                </select>
              </div>

              {/* Items — compact rows */}
              <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', marginBottom: 10 }}>
                {Object.entries(cartByCategory).map(([category, list], ci) => (
                  <div key={category}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--txt3)',
                      background: 'var(--bg)', padding: '4px 12px', letterSpacing: '0.5px',
                      borderTop: ci > 0 ? '1px solid var(--border)' : 'none' }}>
                      {category.toUpperCase()}
                    </div>
                    {list.map(({ item, qty }, idx) => {
                      const stock = getStock(item.id)
                      const afterStock = Math.max(0, stock - qty)
                      const bal = balances.find(b => b.itemId === item.id && b.warehouseId === shopWH)
                      const minQ = bal?.minQty || 0
                      const isLow = afterStock <= minQ
                      return (
                        <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8,
                          padding: '8px 12px', borderTop: idx > 0 ? '1px solid var(--border)' : 'none',
                          background: 'var(--surf)' }}>
                          <span style={{ fontSize: 20 }}>{item.img}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt1)',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {item.displayName || item.name}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                              −{qty} {item.unitUse} · {confirmLoading
                                ? <span style={{ color: 'var(--txt3)' }}>กำลังบันทึก...</span>
                                : <>เหลือ <strong style={{ color: isLow ? '#DC2626' : 'var(--txt2)' }}>{formatStockQty(afterStock, item)}</strong></>}
                            </div>
                          </div>
                          {/* qty editor (−/+/×) */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                            <button onClick={() => { if (qty > 1) setQty(item.id, qty - 1); else setQty(item.id, 0) }}
                              style={{ width: 24, height: 24, borderRadius: 6, border: 'none',
                                background: '#F2F2F7', color: 'var(--txt2)', fontWeight: 700,
                                cursor: 'pointer', fontSize: 13 }}>−</button>
                            <input type="number" value={qty} min="0"
                              onChange={e => {
                                const n = parseFloat(e.target.value)
                                if (!isFinite(n) || n <= 0) setQty(item.id, 0)
                                else setQty(item.id, n)
                              }}
                              style={{ width: 44, padding: '3px 4px', borderRadius: 6,
                                border: '1.5px solid var(--red)', background: '#FFF1F2',
                                fontSize: 13, fontWeight: 700, color: 'var(--red)',
                                textAlign: 'center', outline: 'none' }}/>
                            <button onClick={() => setQty(item.id, qty + 1)}
                              style={{ width: 24, height: 24, borderRadius: 6, border: 'none',
                                background: 'var(--red-p)', color: 'var(--red)', fontWeight: 700,
                                cursor: 'pointer', fontSize: 13 }}>+</button>
                            <button onClick={() => setQty(item.id, 0)}
                              title="ลบรายการนี้"
                              style={{ width: 24, height: 24, borderRadius: 6, border: 'none',
                                background: '#FEE2E2', color: '#DC2626', fontWeight: 700,
                                cursor: 'pointer', fontSize: 11, marginLeft: 2 }}>✕</button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>

              {/* Warnings compact */}
              {warnings.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: '#FFFBEB',
                  border: '1px solid #FDE68A', borderRadius: 10, padding: '8px 12px', marginBottom: 10 }}>
                  <span style={{ fontSize: 14 }}>⚠️</span>
                  <div style={{ fontSize: 11, color: '#92400E', flex: 1 }}>
                    {warnings.map(({ item }) => item.name).join(', ')} ใกล้หมด
                  </div>
                </div>
              )}

              {/* Note for main warehouse */}
              {warehouses.find(w => w.id === shopWH)?.type === 'main' && (
                <textarea value={cutNote} onChange={e => setCutNote(e.target.value)}
                  placeholder="⚠️ ตัดจากคลังกลาง — ระบุเหตุผล..."
                  style={{ width: '100%', borderRadius: 10, border: '1.5px solid #F97316', padding: '8px 12px',
                    fontFamily: 'Sarabun', fontSize: 13, resize: 'none', height: 64,
                    outline: 'none', boxSizing: 'border-box', background: '#FFF7ED' }} />
              )}
            </div>

            <div style={{ padding: '10px 16px', display: 'flex', gap: 8, borderTop: '1px solid var(--border)', background: 'var(--surf)', flexShrink: 0 }}>
              <button className="btn-secondary" style={{ flex: 1, padding: '11px 0', fontSize: 14 }}
                onClick={() => setCartOpen(false)}>ยกเลิก</button>
              <button className="btn-primary" style={{ flex: 2, padding: '11px 0', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                onClick={confirmCut} disabled={confirmLoading}>
                {confirmLoading
                  ? <><span className="snowking-spin" style={{ fontSize: 16 }}>✂️</span> กำลังบันทึก...</>
                  : <>✓ ยืนยันตัดสต็อก</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Usage Pattern popup */}
      <UsagePatternPopup
        open={patternOpen}
        onClose={() => setPatternOpen(false)}
        warehouseId={shopWH}
        items={items}
        balances={balances}
      />
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   UsagePatternPopup — 7/30 วัน + แนะนำสั่งซื้อ
───────────────────────────────────────────────────────────── */
function UsagePatternPopup({ open, onClose, warehouseId, items = [], balances = [] }) {
  const [days, setDays] = useState(7)
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !warehouseId) return
    setLoading(true)
    const today = new Date()
    const start = new Date(today.getTime() - (days - 1) * 86400000)
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    const q = query(
      collection(db, COL.CUT_STOCK_LOGS),
      where('warehouseId', '==', warehouseId),
      where('date', '>=', fmt(start)),
      where('date', '<=', fmt(today)),
    )
    const unsub = onSnapshot(q, snap => {
      setLogs(snap.docs.map(d => d.data()).filter(d => !d.deletedAt))
      setLoading(false)
    })
    return () => unsub()
  }, [open, warehouseId, days])

  // Aggregate per item
  const itemUsage = {}
  logs.forEach(log => {
    (log.items || []).forEach(it => {
      const k = it.itemId
      if (!itemUsage[k]) {
        const master = items.find(i => i.id === k)
        itemUsage[k] = {
          itemId: k,
          name: it.itemName,
          img: it.img || master?.img || '📦',
          unitUse: it.unitUse || master?.unitUse || '',
          total: 0,
        }
      }
      itemUsage[k].total += Number(it.qtyUse) || 0
    })
  })
  const rows = Object.values(itemUsage)
    .map(r => {
      const bal = balances.find(b => b.itemId === r.itemId && b.warehouseId === warehouseId)
      const avgPerDay = r.total / days
      const suggestQty = Math.round(avgPerDay * 7 * 1.2)   // 7 วัน + buffer 20%
      const current = bal?.qty || 0
      return { ...r, avgPerDay, suggestQty, current, gap: Math.max(0, suggestQty - current) }
    })
    .sort((a, b) => b.total - a.total)

  return (
    <Modal open={open} onClose={onClose} title="📊 รูปแบบการใช้งาน">
      <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Period pills */}
        <div style={{ display: 'flex', gap: 6 }}>
          {[7, 30].map(n => (
            <button key={n} onClick={() => setDays(n)}
              style={{ padding: '6px 14px', border: 'none', borderRadius: 20, fontSize: 12,
                fontWeight: 700, cursor: 'pointer',
                background: days === n ? 'var(--red)' : 'var(--bg)',
                color: days === n ? '#fff' : 'var(--txt2)' }}>
              {n} วัน
            </button>
          ))}
        </div>

        {loading && (
          <div style={{ textAlign: 'center', padding: 20, fontSize: 12, color: 'var(--txt3)' }}>
            กำลังโหลด...
          </div>
        )}

        {!loading && rows.length === 0 && (
          <div style={{ textAlign: 'center', padding: 30, fontSize: 13, color: 'var(--txt3)' }}>
            ยังไม่มีประวัติตัดสต็อก {days} วันที่ผ่านมา
          </div>
        )}

        {!loading && rows.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>
              📋 ใช้ทั้งหมด {rows.length} รายการ · แนะนำสั่งซื้อสำหรับสัปดาห์หน้า
            </div>
            {rows.map(r => (
              <div key={r.itemId} style={{ background: 'var(--bg)', borderRadius: 10,
                padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 22 }}>{r.img}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                    ใช้ {r.total.toFixed(1)} {r.unitUse} · เฉลี่ย {r.avgPerDay.toFixed(2)}/วัน
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: 'var(--txt3)' }}>แนะนำสั่ง</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)' }}>
                    {r.suggestQty} {r.unitUse}
                  </div>
                  {r.gap > 0 && (
                    <div style={{ fontSize: 10, color: '#D97706', fontWeight: 700 }}>
                      ขาด {r.gap}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
