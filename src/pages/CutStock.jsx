import { useState, useEffect, useCallback } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, addDoc, writeBatch,
         doc, getDoc, updateDoc, serverTimestamp, increment } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { Modal } from '../components/Modal'
import { Toast } from '../components/Toast'
import { useSession } from '../hooks/useSession'
import { beepClick, beepSuccess } from '../utils/audio'
import { toDateKey, toThaiTime } from '../utils/formatDate'

const CATS = [
  { id: 'fav',      label: '⭐ ของฉัน' },
  { id: 'all',      label: 'ทั้งหมด' },
  { id: 'แยม',     label: '🍓 แยม' },
  { id: 'ผลไม้',   label: '🍋 ผลไม้' },
  { id: 'ไซรัป',   label: '🍯 ไซรัป' },
  { id: 'ท็อปปิ้ง', label: '💎 ท็อปปิ้ง' },
  { id: 'วัตถุดิบ', label: '🥛 วัตถุดิบ' },
  { id: 'บรรจุภัณฑ์', label: '🥤 บรรจุ' },
]

export default function CutStock() {
  const { name, phone } = useSession()
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

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'items'), snap => setItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
    const u2 = onSnapshot(collection(db, 'stock_balances'), snap => setBalances(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
    const u3 = onSnapshot(collection(db, 'quick_templates'), snap => setTemplates(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0))))
    const u4 = onSnapshot(collection(db, 'warehouses'), snap => {
      const whs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(w => w.type === 'branch' && w.active !== false)
      setWarehouses(whs)
      if (!shopWH && whs.length > 0) setShopWH(whs[0].id)
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
    beepClick()
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
    try {
      const today = toDateKey()
      const now = serverTimestamp()
      const shopName = warehouses.find(w => w.id === shopWH)?.name || ''

      const logItems = cartItems.map(({ item, qty }) => ({
        itemId: item.id, itemName: item.name, img: item.img || '📦',
        qtyUse: qty, unitUse: item.unitUse, costTotal: 0
      }))

      // 1. Add cut_stock_logs
      await addDoc(collection(db, 'cut_stock_logs'), {
        date: today, warehouseId: shopWH, shopName,
        staffPhone: phone, staffName: selectedStaff,
        items: logItems, totalCost: 0, timestamp: now
      })

      // 2+3. Batch: reduce stock_balances + add stock_movements
      const batch = writeBatch(db)
      for (const { item, qty } of cartItems) {
        const balId = `${item.id}_${shopWH}`
        const balRef = doc(db, 'stock_balances', balId)
        const balSnap = await getDoc(balRef)
        if (balSnap.exists()) {
          batch.update(balRef, { qty: Math.max(0, (balSnap.data().qty || 0) - qty), lastUpdated: now })
        }
      }

      // 4. Audit log
      batch.set(doc(collection(db, 'audit_logs')), {
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
          await addDoc(collection(db, 'low_stock_alerts'), {
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

      {/* Topbar */}
      <div className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button style={{ border: '1.5px solid var(--border2)', borderRadius: 20, padding: '4px 10px',
            fontSize: 12, fontWeight: 700, background: 'var(--surf)', cursor: 'pointer' }}
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
        </div>
      </div>

      {/* Cart bar */}
      {cartCount > 0 && (
        <div style={{ padding: '0 1rem' }}>
          <div className="cart-bar" onClick={() => setCartOpen(true)}>
            <span className="cart-bar-txt">🛒 ตะกร้า — {cartItems.length} รายการ · กดเพื่อยืนยันตัดสต็อก</span>
            <span className="cart-bar-arrow">›</span>
          </div>
        </div>
      )}

      {/* Category chips */}
      <div className="chip-row">
        {CATS.map(c => (
          <button key={c.id} className={`chip${cat === c.id ? ' active' : ''}`} onClick={() => setCat(c.id)}>
            {c.label}
          </button>
        ))}
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

      {/* POS Grid */}
      <div className="pos-grid">
        {filteredItems.map(item => {
          const qty = cart[item.id] || 0
          const stock = getStock(item.id)
          const isOut = stock <= 0

          return (
            <div key={item.id} className={`pos-card${qty > 0 ? ' selected' : ''}${isOut ? ' out-of-stock' : ''}`}
              onClick={() => !isOut && addItem(item)}>
              {qty > 0 && <span className="pos-qty-badge">{qty}</span>}
              <button className="pos-fav" onClick={e => { e.stopPropagation(); toggleFav(item.id) }}>
                {faves.has(item.id) ? '⭐' : '☆'}
              </button>
              <div className="pos-emoji">{item.img || '📦'}</div>
              <div className="pos-name">{item.name}</div>
              <div className="pos-stock">เหลือ {stock} {item.unitUse}</div>
              <div className="pos-counter" onClick={e => e.stopPropagation()}>
                <button className="pos-btn minus" onClick={() => setQty(item.id, qty - 1)}>−</button>
                <span className="pos-qty-num">{qty}</span>
                <button className="pos-btn plus" onClick={() => { beepClick(); setQty(item.id, qty + 1) }}>+</button>
              </div>
              <div className="pos-unit">{item.unitUse}</div>
            </div>
          )
        })}
      </div>

      {/* Cart confirm popup */}
      {cartOpen && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setCartOpen(false)}>
          <div className="bottom-sheet">
            <div className="sheet-handle" />
            <div className="sheet-header">
              <span className="sheet-title">ยืนยันตัดสต็อก</span>
              <button className="sheet-close" onClick={() => setCartOpen(false)}>✕</button>
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
