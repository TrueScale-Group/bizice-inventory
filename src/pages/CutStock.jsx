import { useState, useEffect, useCallback } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, addDoc, writeBatch,
         doc, getDoc, updateDoc, serverTimestamp, increment } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { Modal } from '../components/Modal'
import { Toast } from '../components/Toast'
import { useSession } from '../hooks/useSession'
import { beepClick, beepSuccess, beepAdd, beepRemove } from '../utils/audio'
import { toDateKey, toThaiTime } from '../utils/formatDate'
import { COL } from '../constants/collections'

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
  const canEdit = isEditor()
  const FAVES_KEY = `fav_${phone}`

  const [cat, setCat] = useState('all')
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

  useEffect(() => {
    const u1 = onSnapshot(collection(db, COL.ITEMS), snap => setItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
    const u2 = onSnapshot(collection(db, COL.STOCK_BALANCES), snap => setBalances(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
    const u3 = onSnapshot(collection(db, COL.QUICK_TEMPLATES), snap => setTemplates(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0))))
    const u4 = onSnapshot(collection(db, COL.WAREHOUSES), snap => {
      const whs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(w => w.active !== false)
      setWarehouses(whs)
      if (!shopWH && whs.length > 0) {
        // ตั้งต้นที่สาขา (warehouse ที่ type === 'shop' หรือ isShop === true)
        // fallback: warehouse ที่ไม่ใช่อันแรก (มักเป็นคลังกลาง) → เลือกอันที่ 2 เป็นต้นไป
        const shop = whs.find(w => w.type === 'shop' || w.isShop === true)
          || whs.find((_, i) => i > 0)
          || whs[0]
        setShopWH(shop.id)
      }
    })
    return () => { u1(); u2(); u3(); u4() }
  }, [])

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
    if (qty <= 0) setCart(c => { const n = { ...c }; delete n[itemId]; return n })
    else setCart(c => ({ ...c, [itemId]: qty }))
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

  // Pre-cut warnings
  const warnings = cartItems.filter(({ item, qty }) => {
    const stock = getStock(item.id)
    const qtyBase = qty // simplified
    return (stock - qtyBase) < (item.minQty || 0)
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
      const today = toDateKey()
      const now = serverTimestamp()
      const shopName = warehouses.find(w => w.id === shopWH)?.name || ''

      const logItems = cartItems.map(({ item, qty }) => ({
        itemId: item.id, itemName: item.name, img: item.img || '📦',
        qtyUse: qty, unitUse: item.unitUse, costTotal: 0
      }))

      // 1. Add cut_stock_logs
      await addDoc(collection(db, COL.CUT_STOCK_LOGS), {
        date: today, warehouseId: shopWH, shopName,
        staffPhone: phone, staffName: selectedStaff,
        items: logItems, totalCost: 0, timestamp: now,
        note: cutNote || ''
      })

      // 2+3. Batch: reduce stock_balances + add stock_movements
      const batch = writeBatch(db)
      for (const { item, qty } of cartItems) {
        const balId = `${item.id}_${shopWH}`
        const balRef = doc(db, COL.STOCK_BALANCES, balId)
        const balSnap = await getDoc(balRef)
        if (balSnap.exists()) {
          batch.update(balRef, { qty: Math.max(0, (balSnap.data().qty || 0) - qty), lastUpdated: now })
        }
      }

      // 4. Audit log
      batch.set(doc(collection(db, COL.AUDIT_LOGS)), {
        action: 'cut_stock', staffPhone: phone, staffName: selectedStaff,
        warehouseId: shopWH, detail: `ตัด ${cartItems.length} รายการ`, timestamp: now
      })

      await batch.commit()

      // 5. Check low stock alerts
      const lowItems = []
      for (const { item, qty } of cartItems) {
        const newStock = Math.max(0, getStock(item.id) - qty)
        if (newStock < (item.minQty || 0)) {
          lowItems.push(item.name)
          await addDoc(collection(db, COL.LOW_STOCK_ALERTS), {
            itemId: item.id, itemName: item.name, warehouseId: shopWH,
            currentQty: newStock, minQty: item.minQty || 0,
            sentAt: now, read: false
          })
        }
      }

      beepSuccess()
      if (lowItems.length > 0) {
        setToast(`🔔 แจ้ง stock ต่ำ: ${lowItems.join(', ')}`)
      } else {
        setToast(`✅ ตัดสต็อก ${cartItems.length} รายการเรียบร้อย`)
      }
      setCart({})
      setCutNote('')
      setCartOpen(false)
    } catch (e) {
      setToast('❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง')
    } finally {
      setConfirmLoading(false)
    }
  }

  const filteredItems = items.filter(i => {
    if (cat === 'fav') return faves.has(i.id)
    if (cat !== 'all') return i.category === cat
    return true
  })

  return (
    <div className="page-pad">
      {toast && <Toast message={toast} onDone={() => setToast('')} />}

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
              style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', position: 'relative' }}>
              🛒
              {cartCount > 0 && (
                <span style={{ position: 'absolute', top: -4, right: -6, background: 'var(--red)',
                  color: '#fff', borderRadius: '50%', width: 16, height: 16, fontSize: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                  {cartCount}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Cart bar — editor only */}
      {canEdit && cartCount > 0 && (
        <div style={{ padding: '0 1rem' }}>
          <div className="cart-bar" onClick={() => setCartOpen(true)}>
            <span className="cart-bar-txt">🛒 ตะกร้า — {cartItems.length} รายการ · กดเพื่อยืนยันตัดสต็อก</span>
            <span className="cart-bar-arrow">›</span>
          </div>
        </div>
      )}

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
                  <div className="pos-name">{item.name}</div>
                  <div className="pos-stock">เหลือ {stock} {item.unitUse}</div>
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
          <div className="bottom-sheet" onClick={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-header">
              <span className="sheet-title">ยืนยันตัดสต็อก</span>
              <button className="sheet-close" onClick={() => !confirmLoading && setCartOpen(false)}>✕</button>
            </div>
            <div className="sheet-body">
              {/* Log info */}
              <div style={{ background: 'var(--bg)', borderRadius: 10, padding: 12, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--txt2)', width: 40 }}>โดย</span>
                  <select className="fi" style={{ flex: 1 }} value={selectedStaff}
                    onChange={e => setSelectedStaff(e.target.value)}>
                    <option value={name}>{name}</option>
                    {staffList.map(s => <option key={s.phone} value={s.name}>{s.name}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--txt2)', width: 40 }}>สาขา</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {warehouses.find(w => w.id === shopWH)?.name || ''}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--txt2)', width: 40 }}>เวลา</span>
                  <span style={{ fontSize: 13 }}>{new Date().toLocaleTimeString('th-TH')}</span>
                </div>
              </div>

              {/* Items by category */}
              {Object.entries(cartByCategory).map(([category, list]) => (
                <div key={category} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt3)', marginBottom: 6 }}>{category}</div>
                  {list.map(({ item, qty }) => {
                    const stock = getStock(item.id)
                    const after = Math.max(0, stock - qty)
                    return (
                      <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                        <input type="checkbox" defaultChecked style={{ width: 16, height: 16 }} />
                        <span style={{ fontSize: 18 }}>{item.img}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                            {qty} {item.unitUse} → เหลือ {after} {item.unitUse}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}

              {/* Warnings */}
              {warnings.length > 0 && (
                <div style={{ background: '#FFF7ED', borderRadius: 10, padding: 12, marginTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#92600A', marginBottom: 6 }}>⚠️ คำเตือน stock ต่ำ</div>
                  {warnings.map(({ item, qty }) => (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <input type="checkbox" style={{ width: 15, height: 15 }} />
                      <span style={{ fontSize: 12, color: '#92600A' }}>
                        {item.name} จะเหลือน้อยกว่า min ({item.minQty} {item.unitUse})
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Note for main warehouse */}
              {warehouses.find(w => w.id === shopWH)?.type === 'main' && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#C2410C', marginBottom: 4 }}>
                    ⚠️ ตัดจากคลังกลาง — ต้องระบุหมายเหตุ *
                  </div>
                  <textarea value={cutNote} onChange={e => setCutNote(e.target.value)}
                    placeholder="ระบุเหตุผลที่ตัดจากคลังกลาง..."
                    style={{ width: '100%', borderRadius: 10, border: '1.5px solid #F97316', padding: '8px 10px',
                      fontFamily: 'Sarabun', fontSize: 13, resize: 'none', height: 72, outline: 'none', boxSizing: 'border-box' }} />
                </div>
              )}
            </div>

            <div style={{ padding: '0 16px 16px', display: 'flex', gap: 10 }}>
              <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setCartOpen(false)}>ยกเลิก</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={confirmCut} disabled={confirmLoading}>
                {confirmLoading ? 'กำลังบันทึก...' : '✓ ยืนยันตัดสต็อก'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Usage Pattern popup */}
      <Modal open={patternOpen} onClose={() => setPatternOpen(false)} title="📊 รูปแบบการใช้งาน">
        <div style={{ color: 'var(--txt3)', textAlign: 'center', padding: '20px 0', fontSize: 14 }}>
          ดูรายงานการใช้งานเฉลี่ย 7 วัน และแนะนำสั่งซื้อ<br />
          <span style={{ fontSize: 12, marginTop: 8, display: 'block' }}>ข้อมูลจะแสดงเมื่อมีประวัติตัดสต็อก</span>
        </div>
      </Modal>
    </div>
  )
}
