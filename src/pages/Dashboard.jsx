import { useState, useEffect } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, orderBy, limit,
         doc, getDoc, addDoc, updateDoc, serverTimestamp, Timestamp, writeBatch } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { Modal } from '../components/Modal'
import { Toast } from '../components/Toast'
import { useSession } from '../hooks/useSession'
import { toThaiDate, toThaiTime, lotDateStr, toDateKey } from '../utils/formatDate'
import { COL } from '../constants/collections'
import { sortLotsFIFO } from '../utils/fifo'
import { beepAdd, beepRemove } from '../utils/audio'

const DEFAULT_SOURCES = ['ตลาดไท', 'ซัพพลายเออร์', 'โอนจากคลัง', 'ซื้อเอง', 'อื่นๆ']

const CATS = [
  { id: 'all', name: 'ทั้งหมด', emoji: '🔍' },
  { id: 'แยม', name: 'แยม', emoji: '🍓' },
  { id: 'ผลไม้', name: 'ผลไม้', emoji: '🍋' },
  { id: 'ไซรัป', name: 'ไซรัป', emoji: '🍯' },
  { id: 'ท็อปปิ้ง', name: 'ท็อปปิ้ง', emoji: '💎' },
  { id: 'วัตถุดิบ', name: 'วัตถุดิบ', emoji: '🥛' },
  { id: 'บรรจุภัณฑ์', name: 'บรรจุ', emoji: '🥤' },
  { id: 'อื่นๆ', name: 'อื่นๆ', emoji: '🔖' },
]

function ItemPickerGrid({ items, balances, warehouseId, selectedId, onSelect, filterFn }) {
  const [cat, setCat] = useState('all')
  const [search, setSearch] = useState('')

  function getStock(itemId) {
    const bals = warehouseId
      ? balances.filter(b => b.itemId === itemId && b.warehouseId === warehouseId)
      : balances.filter(b => b.itemId === itemId)
    return bals.reduce((s, b) => s + (b.qty || 0), 0)
  }

  const filtered = items
    .filter(i => !filterFn || filterFn(i, getStock(i.id)))
    .filter(i => cat === 'all' || i.category === cat)
    .filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Search */}
      <div className="search-wrap" style={{ margin: 0 }}>
        <span className="search-icon">🔍</span>
        <input className="search-input" placeholder="ค้นหา..." value={search}
          onChange={e => setSearch(e.target.value)} />
        {search && <button onClick={() => setSearch('')}
          style={{ border: 'none', background: 'none', color: '#8E8E93', fontSize: 15, cursor: 'pointer', padding: '0 8px' }}>✕</button>}
      </div>
      {/* Sidebar + Grid */}
      <div style={{ display: 'flex', gap: 0, borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
        {/* Sidebar */}
        <div style={{ width: 60, flexShrink: 0, overflowY: 'auto', background: 'var(--bg)', borderRight: '1px solid var(--border)', maxHeight: 320 }}>
          {CATS.map(c => {
            const active = cat === c.id
            return (
              <button key={c.id} onClick={() => setCat(c.id)}
                style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '8px 2px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                  background: active ? 'var(--surf)' : 'transparent',
                  borderLeft: active ? '3px solid var(--red)' : '3px solid transparent' }}>
                <span style={{ fontSize: 16 }}>{c.emoji}</span>
                <span style={{ fontSize: 8.5, fontWeight: active ? 700 : 500,
                  color: active ? 'var(--red)' : 'var(--txt3)', textAlign: 'center', wordBreak: 'break-word', maxWidth: 52 }}>
                  {c.name}
                </span>
              </button>
            )
          })}
        </div>
        {/* Grid */}
        <div style={{ flex: 1, overflowY: 'auto', maxHeight: 320, padding: 8 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--txt3)', fontSize: 12 }}>ไม่มีรายการ</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {filtered.map(item => {
                const stock = getStock(item.id)
                const sel = selectedId === item.id
                return (
                  <div key={item.id} onClick={() => onSelect(item)}
                    style={{ borderRadius: 10, padding: '10px 8px', textAlign: 'center', cursor: 'pointer',
                      border: `2px solid ${sel ? 'var(--red)' : 'var(--border)'}`,
                      background: sel ? 'var(--red-p)' : 'var(--surf)',
                      transition: 'all .15s', position: 'relative' }}>
                    {sel && <span style={{ position: 'absolute', top: 4, right: 6, fontSize: 12 }}>✅</span>}
                    <div style={{ fontSize: 24 }}>{item.img || '📦'}</div>
                    <div style={{ fontSize: 11, fontWeight: 700, marginTop: 4, lineHeight: 1.3 }}>{item.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--txt3)', marginTop: 2 }}>เหลือ {stock} {item.unitBase}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PosQty({ value, onChange, min = 0 }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 0, borderRadius: 12,
      border: '1.5px solid #F59E0B', overflow: 'hidden', background: '#FFF9EF', width: 'fit-content' }}>
      <button onClick={() => { beepRemove(); onChange(Math.max(min, (value||0) - 1)) }}
        style={{ width: 40, height: 40, border: 'none', background: 'transparent',
          fontSize: 22, fontWeight: 700, color: '#F59E0B', cursor: 'pointer', lineHeight: 1 }}>
        −
      </button>
      <span style={{ minWidth: 38, textAlign: 'center', fontFamily: 'Prompt',
        fontWeight: 700, fontSize: 17, color: '#1C1C1E' }}>
        {value || 0}
      </span>
      <button onClick={() => { beepAdd(); onChange((value||0) + 1) }}
        style={{ width: 40, height: 40, border: 'none', background: '#F59E0B',
          fontSize: 22, fontWeight: 700, color: '#fff', cursor: 'pointer', lineHeight: 1 }}>
        +
      </button>
    </div>
  )
}

function UnitChips({ opts, selected, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {opts.map(o => {
        const active = selected === o.value
        return (
          <button key={o.value} onClick={() => onChange(o.value)}
            style={{ padding: '5px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: active ? '#F59E0B' : '#F3F4F6',
              color: active ? '#fff' : '#374151',
              fontWeight: active ? 700 : 500, fontSize: 13,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
            <span>{o.label}</span>
            {o.sub && <span style={{ fontSize: 9, opacity: 0.8 }}>{o.sub}</span>}
          </button>
        )
      })}
    </div>
  )
}

export default function Dashboard() {
  const { name, isEditor, isOwner } = useSession()
  const [wh, setWh] = useState('all')
  const [warehouses, setWarehouses] = useState([])
  const [kpi, setKpi] = useState({ cost: 0, cuts: 0, low: 0, out: 0 })
  const [alerts, setAlerts] = useState([])
  const [transfers, setTransfers] = useState([])
  const [items, setItems] = useState([])
  const [balances, setBalances] = useState([])
  const [sources, setSources] = useState(DEFAULT_SOURCES)
  const [toast, setToast] = useState('')
  const [expAlerts, setExpAlerts] = useState([]) // lots expiring within 7 days with qty > 0

  // Modals
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [refillOpen, setRefillOpen] = useState(false)
  const [wasteOpen, setWasteOpen] = useState(false)
  const [bellOpen, setBellOpen] = useState(false)

  // Receive form
  const [receiveSaving, setReceiveSaving] = useState(false)
  const [rcv, setRcv] = useState({
    itemId: '', qty: '', unit: '', receiveDate: '', mfgDate: '', expDate: '', source: DEFAULT_SOURCES[0]
  })

  // Transfer form — multi-item
  const [tfr, setTfr] = useState({ fromWH: '', toWH: '', driver: '' })
  const [transferItems, setTransferItems] = useState([])
  const [tfAddMode, setTfAddMode]         = useState(false)
  const [transferSaving, setTransferSaving] = useState(false)

  // Refill request
  const [refillSelected, setRefillSelected] = useState(new Set())
  const [refillQtys, setRefillQtys]         = useState({}) // itemId → number
  const [refillUnits, setRefillUnits]       = useState({}) // itemId → unit string
  const [refillCat, setRefillCat]           = useState('low') // 'low' | category name
  const [refillRequests, setRefillRequests] = useState([]) // RF pending docs
  const [refillSaving, setRefillSaving]     = useState(false)
  const [rfSelectedIds, setRfSelectedIds]   = useState(new Set()) // RF ids ที่เลือกรวม (dashboard section)
  const [rfDeleteId, setRfDeleteId]         = useState(null)
  const [rfDeleteReason, setRfDeleteReason] = useState('')
  const [rfDeleting, setRfDeleting]         = useState(false)
  // RF import inside transfer modal
  const [tfrRFImport, setTfrRFImport]       = useState(new Set()) // RF ids ที่จะ import เข้า modal
  const [tfrRFExpand, setTfrRFExpand]       = useState(false)     // แสดง/ซ่อน RF picker

  // Receive transfer modal
  const [receiveTransferOpen, setReceiveTransferOpen] = useState(false)
  const [receivingTF, setReceivingTF]                 = useState(null)  // TF doc being received
  const [receivingChecked, setReceivingChecked]       = useState(new Set()) // indices ticked
  const [receivingSaving, setReceivingSaving]         = useState(false)

  // Waste form
  const [waste, setWaste] = useState({ itemId: '', qty: '', unit: '', type: 'fruit_daily' })
  const [wasteSaving, setWasteSaving] = useState(false)
  const [cmCosts, setCmCosts] = useState({}) // itemName → { costPerUse }

  // โหลด Cost Manager library สำหรับคำนวณมูลค่า
  useEffect(() => {
    getDoc(doc(db, 'mixue_data', 'mixue-cost-manager')).then(snap => {
      if (!snap.exists()) return
      const lib = snap.data().library || []
      const map = {}
      lib.forEach(it => {
        const levels = it.levels || []
        // CM fields: basePrice = ราคาซื้อ/ลัง, unitPrice = ฿/หน่วยย่อยสุด, qty = จำนวนหน่วยย่อย/ลัง
        const rawPrice   = it.basePrice || it.price || it.total || 0
        const convBuyToUse = levels[1]?.qty || 1   // unitUse ต่อ 1 unitBuy
        const convUseToSub = levels[2]?.qty || 1   // unitSub ต่อ 1 unitUse
        // costPerUse = ต้นทุน ต่อ 1 unitUse (levels[1].name)
        const costPerUse = rawPrice > 0
          ? rawPrice / convBuyToUse
          : (it.unitPrice || 0) * convUseToSub
        map[it.name] = { costPerUse, unitPrice: it.unitPrice || 0 }
      })
      setCmCosts(map)
    })
  }, [])

  /** คำนวณมูลค่าของเสียตาม unit ที่เลือก */
  function calcWasteCost(item, unit, qty) {
    const q = parseFloat(qty) || 0
    if (!q || !item) return 0
    const cm = cmCosts[item.name]
    if (!cm) return 0
    const cpu = cm.costPerUse || 0  // ต้นทุน / unitUse
    if (unit === item.unitSub && item.convUseToSub) return q * cpu / item.convUseToSub
    if (unit === item.unitBuy && item.convBuyToUse) return q * cpu * item.convBuyToUse
    return q * cpu  // unitUse หรือ default
  }

  /** สร้าง options หน่วยจาก item fields */
  function getUnitOptions(item) {
    if (!item) return []
    const opts = []
    if (item.unitBuy) opts.push({ label: item.unitBuy, value: item.unitBuy,
      sub: item.convBuyToUse ? `= ${item.convBuyToUse} ${item.unitUse}` : '' })
    if (item.unitUse && item.unitUse !== item.unitBuy) opts.push({ label: item.unitUse, value: item.unitUse, sub: 'หน่วยตัด' })
    if (item.unitSub && item.unitSub !== item.unitUse) opts.push({ label: item.unitSub, value: item.unitSub,
      sub: item.convUseToSub ? `${item.convUseToSub}/${item.unitUse}` : '' })
    // fallback
    if (opts.length === 0 && item.unitBase) opts.push({ label: item.unitBase, value: item.unitBase, sub: '' })
    return opts
  }

  async function saveWaste() {
    if (!waste.itemId || !waste.qty) {
      setToast('⚠️ กรุณาเลือกวัตถุดิบและระบุจำนวน')
      return
    }
    setWasteSaving(true)
    try {
      const item = items.find(i => i.id === waste.itemId)
      const unit = waste.unit || item?.unitUse || item?.unitBase || ''
      const totalCost = calcWasteCost(item, unit, waste.qty)
      await addDoc(collection(db, COL.WASTE_LOGS), {
        date: toDateKey(),
        type: waste.type,
        itemId: waste.itemId,
        itemName: item?.name || '',
        img: item?.img || '📦',
        qty: parseFloat(waste.qty) || 0,
        unit,
        totalCost,
        staffName: name,
        timestamp: serverTimestamp(),
      })
      setToast(`✅ บันทึกของเสีย: ${item?.name} ${waste.qty} ${unit}${totalCost ? ` (฿${totalCost.toFixed(2)})` : ''}`)
      setWaste({ itemId: '', qty: '', unit: '', type: 'fruit_daily' })
      setWasteOpen(false)
    } catch (e) {
      setToast('❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง')
    } finally {
      setWasteSaving(false)
    }
  }

  // Load warehouses
  useEffect(() => {
    const unsub = onSnapshot(collection(db, COL.WAREHOUSES), snap => {
      setWarehouses(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(w => w.active !== false))
    })
    return () => unsub()
  }, [])

  // Load items
  useEffect(() => {
    const unsub = onSnapshot(collection(db, COL.ITEMS), snap => {
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // Load balances
  useEffect(() => {
    const unsub = onSnapshot(collection(db, COL.STOCK_BALANCES), snap => {
      setBalances(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // Load sources from settings
  useEffect(() => {
    getDoc(doc(db, COL.APP_SETTINGS, 'sources')).then(snap => {
      if (snap.exists() && snap.data().list?.length) setSources(snap.data().list)
    })
  }, [])

  // Load KPI (today cut logs)
  useEffect(() => {
    const today = toDateKey()
    const q = wh === 'all'
      ? query(collection(db, COL.CUT_STOCK_LOGS), where('date', '==', today))
      : query(collection(db, COL.CUT_STOCK_LOGS), where('date', '==', today), where('warehouseId', '==', wh))
    const unsub = onSnapshot(q, snap => {
      const logs = snap.docs.map(d => d.data()).filter(d => !d.deletedAt)
      const cost = logs.reduce((s, l) => s + (l.totalCost || 0), 0)
      setKpi(k => ({ ...k, cost, cuts: logs.length }))
    })
    return () => unsub()
  }, [wh])

  // Load alerts
  useEffect(() => {
    const q = query(collection(db, COL.LOW_STOCK_ALERTS), where('read', '==', false), limit(10))
    const unsub = onSnapshot(q, snap => {
      setAlerts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // Load EXP alerts (lots expiring within 7 days with qty > 0)
  useEffect(() => {
    const unsub = onSnapshot(collection(db, COL.LOT_TRACKING), snap => {
      const now = new Date()
      const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      const expiring = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(lot => {
          const qty = (lot.inWarehouse || 0) + (lot.inShop || 0)
          if (qty <= 0) return false
          if (!lot.expDate) return false
          const exp = new Date(lot.expDate)
          return exp <= in7
        })
        .map(lot => {
          const exp = new Date(lot.expDate)
          const daysLeft = Math.ceil((exp - new Date()) / (1000 * 60 * 60 * 24))
          return { ...lot, daysLeft }
        })
      setExpAlerts(expiring)
    })
    return () => unsub()
  }, [])

  // Load active transfers (pending + in_transit)
  useEffect(() => {
    const q = query(collection(db, COL.TRANSFER_ORDERS),
      where('status', 'in', ['pending', 'in_transit']), limit(10))
    const unsub = onSnapshot(q, snap => {
      setTransfers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // Load pending refill requests
  // ไม่ใช้ orderBy ใน query เพื่อหลีกเลี่ยง Composite Index requirement
  // — sort ใน client แทน
  useEffect(() => {
    const q = query(collection(db, COL.REFILL_REQUESTS),
      where('status', 'in', ['pending', 'processing']), limit(30))
    const unsub = onSnapshot(q, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      // เรียงเก่าสุดขึ้นก่อน (pending เก่าสุดควรดำเนินการก่อน)
      docs.sort((a, b) => (a.requestedAt?.seconds || 0) - (b.requestedAt?.seconds || 0))
      setRefillRequests(docs)
    }, err => {
      console.error('RF snapshot error:', err)
    })
    return () => unsub()
  }, [])

  // Load low/out stock
  useEffect(() => {
    const q = wh === 'all'
      ? query(collection(db, COL.STOCK_BALANCES))
      : query(collection(db, COL.STOCK_BALANCES), where('warehouseId', '==', wh))
    const unsub = onSnapshot(q, snap => {
      const balances = snap.docs.map(d => d.data())
      let low = 0, out = 0
      balances.forEach(b => {
        const item = items.find(i => i.id === b.itemId)
        if (!item) return
        if (b.qty <= 0) out++
        else if (b.qty <= item.minQty) low++
      })
      setKpi(k => ({ ...k, low, out }))
    })
    return () => unsub()
  }, [wh, items])

  const whName = wh === 'all' ? 'ทุกร้าน' : (warehouses.find(w => w.id === wh)?.name || wh)

  async function submitReceive() {
    if (!rcv.itemId || !rcv.qty) { setToast('⚠️ กรุณาเลือกวัตถุดิบและระบุจำนวน'); return }
    if (!rcv.receiveDate) { setToast('⚠️ กรุณาระบุวันที่รับสินค้า'); return }
    const item = items.find(i => i.id === rcv.itemId)
    if (!item) return
    setReceiveSaving(true)
    try {
      const batch = writeBatch(db)
      const lotId = `${rcv.itemId}_${rcv.receiveDate.replace(/\//g, '')}`
      const balId = `${rcv.itemId}_${rcv.itemId}`
      const qty = parseFloat(rcv.qty)

      batch.set(doc(db, COL.LOT_TRACKING, lotId), {
        itemId: rcv.itemId, itemName: item.name,
        warehouseId: rcv.fromWH || warehouses[0]?.id || '',
        receiveDate: rcv.receiveDate, mfgDate: rcv.mfgDate, expDate: rcv.expDate,
        totalQty: qty, inWarehouse: qty, inShop: 0, used: 0,
        source: rcv.source, createdAt: serverTimestamp()
      }, { merge: true })

      const balRef = doc(db, COL.STOCK_BALANCES, balId)
      const balSnap = await getDoc(balRef)
      if (balSnap.exists()) {
        batch.update(balRef, { qty: (balSnap.data().qty || 0) + qty, lastUpdated: serverTimestamp() })
      } else {
        batch.set(balRef, { itemId: rcv.itemId, warehouseId: rcv.fromWH || warehouses[0]?.id || '',
          qty, unit: item.unitBase, lastUpdated: serverTimestamp(), lastUpdatedBy: window._bizSession?.phone || '' })
      }

      await batch.commit()
      await addDoc(collection(db, COL.STOCK_MOVEMENTS), {
        type: 'receive', itemId: rcv.itemId, itemName: item.name,
        warehouseId: rcv.fromWH || warehouses[0]?.id || '',
        qty, unit: item.unitBase, unitUse: item.unitUse, qtyUse: qty,
        staffPhone: window._bizSession?.phone || '', staffName: window._bizSession?.name || '',
        shopName: whName, timestamp: serverTimestamp(), note: `รับจาก ${rcv.source}`
      })
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'receive', staffPhone: window._bizSession?.phone || '',
        staffName: window._bizSession?.name || '', warehouseId: rcv.fromWH || '',
        detail: `รับ ${item.name} ${qty} ${item.unitBase}`, timestamp: serverTimestamp()
      })
      setReceiveOpen(false)
      setRcv({ itemId: '', qty: '', unit: '', receiveDate: '', mfgDate: '', expDate: '', source: sources[0] || DEFAULT_SOURCES[0] })
      setToast(`✅ รับสินค้า ${item.name} ${qty} ${item.unitBase} เรียบร้อย`)
    } catch (e) {
      console.error(e)
      setToast('❌ เกิดข้อผิดพลาด กรุณาลองใหม่')
    } finally {
      setReceiveSaving(false)
    }
  }

  async function receiveTransfer(tf) {
    try {
      const batch = writeBatch(db)
      const tfLabel = `#TF-${tf.id.slice(-6).toUpperCase()}`
      const fromName = warehouses.find(w => w.id === tf.fromWarehouseId)?.name || tf.fromWarehouseName || 'คลังต้นทาง'
      const toName = warehouses.find(w => w.id === tf.toWarehouseId)?.name || tf.toWarehouseName || 'คลังปลายทาง'

      // Update each item's stock balance at destination warehouse
      for (const item of (tf.items || [])) {
        const toBalId = `${item.itemId}_${tf.toWarehouseId}`
        const toBalRef = doc(db, COL.STOCK_BALANCES, toBalId)
        const toBalSnap = await getDoc(toBalRef)
        const addQty = parseFloat(item.qty) || 0
        if (toBalSnap.exists()) {
          batch.update(toBalRef, {
            qty: (toBalSnap.data().qty || 0) + addQty,
            lastUpdated: serverTimestamp(),
            lastUpdatedBy: name || ''
          })
        } else {
          batch.set(toBalRef, {
            itemId: item.itemId,
            warehouseId: tf.toWarehouseId,
            qty: addQty,
            unit: item.unit || '',
            lastUpdated: serverTimestamp(),
            lastUpdatedBy: name || ''
          })
        }

        // Reduce from source warehouse
        const fromBalId = `${item.itemId}_${tf.fromWarehouseId}`
        const fromBalRef = doc(db, COL.STOCK_BALANCES, fromBalId)
        const fromBalSnap = await getDoc(fromBalRef)
        if (fromBalSnap.exists()) {
          const newQty = Math.max(0, (fromBalSnap.data().qty || 0) - addQty)
          batch.update(fromBalRef, { qty: newQty, lastUpdated: serverTimestamp() })
        }
      }

      // Mark transfer as received
      batch.update(doc(db, COL.TRANSFER_ORDERS, tf.id), {
        status: 'received',
        receivedBy: name || '',
        receivedAt: serverTimestamp()
      })

      await batch.commit()

      // Add audit log
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'transfer_received',
        staffName: name || '',
        detail: `รับโอน ${tfLabel} จาก ${fromName} ไปยัง ${toName}`,
        timestamp: serverTimestamp()
      })

      setToast(`✅ รับสินค้าเรียบร้อย`)
    } catch (e) {
      console.error(e)
      setToast('❌ เกิดข้อผิดพลาด กรุณาลองใหม่')
    }
  }

  /** บันทึกใบแจ้งเติมของ (staff กดแจ้ง → จบ) */
  async function submitRefill() {
    if (refillSelected.size === 0) { setToast('⚠️ กรุณาเลือกรายการที่ต้องการเติม'); return }
    setRefillSaving(true)
    try {
      const _now = new Date()
      const _mm  = String(_now.getMonth() + 1).padStart(2, '0')
      const _yy  = String(_now.getFullYear()).slice(-2)
      const _seq = String(Date.now()).slice(-2)
      const rfId = `RF-${_mm}.${_yy}-${_seq}`
      const rfItems = [...refillSelected].map(id => {
        const item = items.find(i => i.id === id)
        if (!item) return null
        return {
          itemId: id, itemName: item.name, img: item.img || '📦',
          category: item.category || 'อื่นๆ',
          unit: refillUnits[id] || item.unitUse || item.unitBase || '',
          qty: refillQtys[id] || 0,
        }
      }).filter(Boolean)
      await addDoc(collection(db, COL.REFILL_REQUESTS), {
        rfRef: rfId, status: 'pending',
        items: rfItems,
        requestedBy: name || window._bizSession?.name || '',
        requestedAt: serverTimestamp(),
      })
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'refill_request', staffName: name,
        detail: `แจ้งเติมของ ${rfId} — ${rfItems.length} รายการ`,
        timestamp: serverTimestamp()
      })
      setRefillOpen(false)
      setRefillSelected(new Set())
      setRefillQtys({})
      setRefillUnits({})
      setRefillCat('low')
      setToast(`✅ แจ้งเติมของ ${rfId} เรียบร้อย — รอคลังดำเนินการ`)
    } catch(e) {
      setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setRefillSaving(false)
    }
  }

  /** เปิด transfer modal พร้อม pre-fill จาก RF doc */
  /** merge items จาก RF array เข้า transferItems (รวม qty ถ้า itemId ซ้ำ) */
  function mergeRFsIntoItems(rfs) {
    const merged = {}
    // เอา existing items ก่อน
    transferItems.forEach(it => { merged[it.itemId] = { ...it } })
    // merge จาก RF ที่เลือก
    rfs.forEach(rf => {
      ;(rf.items || []).forEach(it => {
        const itemMaster = items.find(i => i.id === it.itemId)
        const unitOpts = []
        if (itemMaster?.unitUse)  unitOpts.push(itemMaster.unitUse)
        if (itemMaster?.unitBase && !unitOpts.includes(itemMaster.unitBase)) unitOpts.push(itemMaster.unitBase)
        if (unitOpts.length === 0 && it.unit) unitOpts.push(it.unit)

        if (merged[it.itemId]) {
          merged[it.itemId].qty = String(parseFloat(merged[it.itemId].qty || 0) + parseFloat(it.qty || 0))
        } else {
          merged[it.itemId] = {
            itemId: it.itemId, itemName: it.itemName, img: it.img || '📦',
            category: it.category || 'อื่นๆ',
            qty: it.qty ? String(it.qty) : '',
            unit: unitOpts[0] || it.unit || '',
            unitOpts,
          }
        }
      })
    })
    setTransferItems(Object.values(merged))
  }

  /** เปิด modal สร้างใบโอน (เปล่า — ให้ user เลือก RF เอง) */
  function openTransferFromRFs(rfs) {
    setTransferItems([])
    setTfr({ fromWH: '', toWH: '', driver: '', _rfIds: [], _rfRefs: [] })
    setTfAddMode(false)
    setTfrRFExpand(true)  // เปิด RF picker อัตโนมัติ
    // pre-select ถ้า user กดมาจาก sticky bar
    setTfrRFImport(new Set(rfs.map(r => r.id)))
    setRfSelectedIds(new Set())
    setTransferOpen(true)
  }

  // backward-compat: เปิดจาก RF เดี่ยว (ยังใช้ใน FlowCard)
  function openTransferFromRF(rf) { openTransferFromRFs([rf]) }

  /** เปิด modal เปล่า (จากปุ่ม "โอนสินค้า") */
  function openTransferBlank() {
    setTransferItems([])
    setTfr({ fromWH: '', toWH: '', driver: '', _rfIds: [], _rfRefs: [] })
    setTfAddMode(false)
    setTfrRFExpand(refillRequests.filter(r => r.status === 'pending').length > 0)
    setTfrRFImport(new Set())
    setTransferOpen(true)
  }

  /** ยกเลิก/ลบ RF พร้อมบันทึกเหตุผลลง audit_log */
  async function deleteRF(rfId, rfRef, reason) {
    if (!reason || reason.trim().length < 3) {
      setToast('⚠️ กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร'); return
    }
    setRfDeleting(true)
    try {
      await updateDoc(doc(db, COL.REFILL_REQUESTS, rfId), {
        status: 'cancelled',
        cancelledBy: name,
        cancelReason: reason.trim(),
        cancelledAt: serverTimestamp(),
      })
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'refill_cancel',
        staffName: name,
        detail: `ยกเลิกคำร้อง ${rfRef || rfId.slice(-8)} | เหตุผล: ${reason.trim()}`,
        timestamp: serverTimestamp(),
      })
      setRfDeleteId(null)
      setRfDeleteReason('')
      setToast(`🗑️ ยกเลิกคำร้อง ${rfRef || ''} แล้ว`)
    } catch(e) {
      console.error(e); setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setRfDeleting(false)
    }
  }

  /** สร้างใบโอนสินค้า + เริ่มนำส่งทันที (status = in_transit) */
  async function submitTransfer() {
    if (!tfr.fromWH || !tfr.toWH || transferItems.length === 0) {
      setToast('⚠️ กรุณาเลือกคลังและเพิ่มวัตถุดิบอย่างน้อย 1 รายการ'); return
    }
    if (tfr.fromWH === tfr.toWH) { setToast('⚠️ คลังต้นทางและปลายทางต้องไม่เหมือนกัน'); return }
    const hasQty = transferItems.every(it => parseFloat(it.qty) > 0)
    if (!hasQty) { setToast('⚠️ กรุณาระบุจำนวนทุกรายการ'); return }
    setTransferSaving(true)
    try {
      const fromName = warehouses.find(w => w.id === tfr.fromWH)?.name || tfr.fromWH
      const toName   = warehouses.find(w => w.id === tfr.toWH)?.name  || tfr.toWH
      const _tn  = new Date()
      const _tmm = String(_tn.getMonth() + 1).padStart(2, '0')
      const _tyy = String(_tn.getFullYear()).slice(-2)
      const _tseq = String(Date.now()).slice(-2)
      const tfId = `TF-${_tmm}.${_tyy}-${_tseq}`
      const itemsPayload = transferItems.map(it => ({
        itemId: it.itemId, itemName: it.itemName, img: it.img,
        category: it.category || 'อื่นๆ',
        qty: parseFloat(it.qty), unit: it.unit,
      }))
      const tfDoc = await addDoc(collection(db, COL.TRANSFER_ORDERS), {
        tfRef: tfId, status: 'in_transit',
        fromWarehouseId: tfr.fromWH, fromWarehouseName: fromName,
        toWarehouseId:   tfr.toWH,   toWarehouseName:   toName,
        driver: tfr.driver,
        items: itemsPayload,
        refillRequestId: tfr._rfId || null, refillRef: tfr._rfRef || null,
        createdBy: name, createdAt: serverTimestamp(),
        departedBy: name, departedAt: serverTimestamp(),
      })
      // อัปเดต RF status → processing (รองรับทั้ง _rfIds array และ _rfId เดี่ยว legacy)
      const rfIds = tfr._rfIds?.length ? tfr._rfIds : (tfr._rfId ? [tfr._rfId] : [])
      for (const rfId of rfIds) {
        await updateDoc(doc(db, COL.REFILL_REQUESTS, rfId), {
          status: 'processing', transferOrderId: tfDoc.id, tfRef: tfId
        })
      }
      const rfRefs = tfr._rfRefs?.join(', ') || tfr._rfRef || ''
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'transfer_dispatch', staffName: name,
        detail: `สร้าง+นำส่ง ${tfId} จาก ${fromName} → ${toName} (${itemsPayload.length} รายการ) | คนนำส่ง: ${tfr.driver || '-'}${rfRefs ? ' | RF: ' + rfRefs : ''}`,
        timestamp: serverTimestamp()
      })
      setTransferOpen(false)
      setTransferItems([])
      setTfr({ fromWH: '', toWH: '', driver: '' })
      setToast(`✅ นำส่งใบโอน ${tfId} แล้ว — รอหน้าร้านยืนยันรับ`)
    } catch(e) {
      console.error(e); setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setTransferSaving(false)
    }
  }

  /** เปิด modal รับสินค้า */
  function openReceiveTransfer(tf) {
    setReceivingTF(tf)
    setReceivingChecked(new Set())
    setReceiveTransferOpen(true)
  }

  /** ยืนยันรับสินค้า — ปรับ stock ทั้ง 2 ฝั่ง */
  async function confirmReceiveTransfer() {
    if (!receivingTF) return
    const tf = receivingTF
    const allIndices = new Set((tf.items || []).map((_, i) => i))
    const allChecked = [...allIndices].every(i => receivingChecked.has(i))
    if (!allChecked) { setToast('⚠️ กรุณาติ๊กถูกทุกรายการก่อนยืนยัน'); return }
    setReceivingSaving(true)
    try {
      const batch = writeBatch(db)
      const fromName = tf.fromWarehouseName || tf.fromWarehouseId
      const toName   = tf.toWarehouseName   || tf.toWarehouseId
      // ปรับ stock
      for (const it of (tf.items || [])) {
        const addQty  = parseFloat(it.qty) || 0
        // เพิ่มที่ปลายทาง
        const toRef  = doc(db, COL.STOCK_BALANCES, `${it.itemId}_${tf.toWarehouseId}`)
        const toSnap = await getDoc(toRef)
        if (toSnap.exists()) {
          batch.update(toRef, { qty: (toSnap.data().qty || 0) + addQty, lastUpdated: serverTimestamp() })
        } else {
          batch.set(toRef, { itemId: it.itemId, warehouseId: tf.toWarehouseId,
            qty: addQty, unit: it.unit, lastUpdated: serverTimestamp(), lastUpdatedBy: name })
        }
        // ลดที่ต้นทาง
        const frRef  = doc(db, COL.STOCK_BALANCES, `${it.itemId}_${tf.fromWarehouseId}`)
        const frSnap = await getDoc(frRef)
        if (frSnap.exists()) {
          batch.update(frRef, { qty: Math.max(0, (frSnap.data().qty || 0) - addQty), lastUpdated: serverTimestamp() })
        }
      }
      // อัปเดต TF
      batch.update(doc(db, COL.TRANSFER_ORDERS, tf.id), {
        status: 'received', receivedBy: name, receivedAt: serverTimestamp()
      })
      // อัปเดต RF → done
      if (tf.refillRequestId) {
        batch.update(doc(db, COL.REFILL_REQUESTS, tf.refillRequestId), { status: 'done' })
      }
      await batch.commit()
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'transfer_received', staffName: name,
        detail: `รับสินค้า ${tf.tfRef || tf.id} จาก ${fromName} · คนนำส่ง: ${tf.driver || '-'} · รับโดย: ${name}`,
        timestamp: serverTimestamp()
      })
      setReceiveTransferOpen(false)
      setReceivingTF(null)
      setToast(`✅ รับสินค้า ${tf.tfRef || ''} ครบถ้วน — stock อัปเดตแล้ว`)
    } catch(e) {
      console.error(e); setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setReceivingSaving(false)
    }
  }

  const todayStr = toThaiDate()

  // Bell alert count: unresolved low_stock_alerts + expiring lots
  const unresolvedAlerts = alerts.filter(a => a.resolved !== true)
  const alertCount = unresolvedAlerts.length + expAlerts.length

  async function dismissAlert(alertId) {
    await updateDoc(doc(db, COL.LOW_STOCK_ALERTS, alertId), { resolved: true })
  }

  return (
    <div className="page-pad">
      {toast && <Toast message={toast} onDone={() => setToast('')} />}

      {/* Date + bell bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 1rem 0' }}>
        <div style={{ fontSize: 12, color: 'var(--txt3)', fontWeight: 500 }}>{todayStr}</div>
        <button onClick={() => setBellOpen(true)}
          style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', position: 'relative', padding: '2px 4px' }}>
          🔔
          {alertCount > 0 && (
            <span style={{
              position: 'absolute', top: 0, right: 0, background: 'var(--red)',
              color: '#fff', borderRadius: 8, minWidth: 16, height: 16,
              fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
              padding: '0 3px'
            }}>{alertCount}</span>
          )}
        </button>
      </div>

      {/* Warehouse segment */}
      <div style={{ padding: '0 1rem' }}>
        <div className="segment">
          <button className={`seg-btn${wh === 'all' ? ' active' : ''}`} onClick={() => setWh('all')}>ทุกร้าน</button>
          {warehouses.map(w => (
            <button key={w.id} className={`seg-btn${wh === w.id ? ' active' : ''}`} onClick={() => setWh(w.id)}>
              {w.name}
            </button>
          ))}
        </div>
      </div>

      {/* Hero card */}
      <div style={{ padding: '0 1rem' }}>
        <div className="hero-card">
          <div className="hero-label">มูลค่าใช้วัตถุดิบวันนี้ — {whName}</div>
          <div className="hero-val">฿{kpi.cost.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</div>
          <div className="hero-sub">เชื่อม Cost Manager · real-time</div>
        </div>
      </div>

      {/* KPI 2x2 */}
      <div style={{ padding: '0 1rem' }}>
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">ต้นทุนวัตถุดิบ</div>
            <div className="kpi-val" style={{ fontSize: 18, color: 'var(--red)' }}>
              ฿{kpi.cost.toLocaleString()}
            </div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">ครั้งตัดวันนี้</div>
            <div className="kpi-val">{kpi.cuts}</div>
            <div className="kpi-sub">ครั้ง</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">ใกล้หมด</div>
            <div className="kpi-val" style={{ color: '#D97706' }}>{kpi.low}</div>
            <div className="kpi-sub">รายการ</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">หมดแล้ว</div>
            <div className="kpi-val" style={{ color: '#DC2626' }}>{kpi.out}</div>
            <div className="kpi-sub">รายการ</div>
          </div>
        </div>
      </div>

      {/* ── Flow Status Cards ── */}
      {(() => {
        const rfPending    = refillRequests.filter(r => r.status === 'pending')
        const rfProcessing = refillRequests.filter(r => r.status === 'processing')
        const tfInTransit  = transfers.filter(t => t.status === 'in_transit')
        const lowAlerts    = alerts.filter(a => a.resolved !== true)
        const hasAny = rfPending.length || rfProcessing.length || tfInTransit.length || lowAlerts.length || expAlerts.length

        const FlowCard = ({ icon, title, sub, badge, badgeColor, badgeBg, borderColor, bg, onClick }) => (
          <div onClick={onClick}
            style={{ background: bg || '#fff', border: `1.5px solid ${borderColor || 'var(--border)'}`,
              borderRadius: 14, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12,
              cursor: onClick ? 'pointer' : 'default', flexShrink: 0 }}>
            <span style={{ fontSize: 24, flexShrink: 0 }}>{icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>{title}</div>
              {sub && <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>{sub}</div>}
            </div>
            {badge != null && (
              <span style={{ background: badgeBg || '#F3F4F6', color: badgeColor || '#6B7280',
                borderRadius: 20, padding: '3px 10px', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                {badge}
              </span>
            )}
          </div>
        )

        return (
          <div style={{ padding: '0 1rem' }}>
            <div className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              ⚠️ แจ้งเตือน / สถานะเตรียมของ
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

              {/* RF pending — summary chip เท่านั้น */}
              {rfPending.length > 0 && (
                <FlowCard
                  icon="📋" bg="#FFFBEB" borderColor="#FCD34D"
                  title="คำร้องแจ้งเติมของ"
                  sub={`มี ${rfPending.length} คำร้องรอดำเนินการ — เลื่อนลงเพื่อดูรายละเอียด`}
                  badge={rfPending.length} badgeBg="#FEF3C7" badgeColor="#D97706"
                />
              )}

              {/* RF processing — มีใบโอนแล้ว กำลังเตรียม */}
              {rfProcessing.length > 0 && (
                <FlowCard
                  icon="📦" bg="#EFF6FF" borderColor="#BFDBFE"
                  title="กำลังเตรียมสินค้า"
                  sub={rfProcessing.map(r => `${r.rfRef||''} → ${r.tfRef||'มีใบโอนแล้ว'}`).join(' · ')}
                  badge={rfProcessing.length} badgeBg="#DBEAFE" badgeColor="#1D4ED8"
                />
              )}

              {/* TF in_transit — กำลังนำส่ง รอตรวจรับ */}
              {tfInTransit.length > 0 && (
                <FlowCard
                  icon="🚚" bg="#F0FDF4" borderColor="#86EFAC"
                  title="สินค้ากำลังนำส่ง — รอตรวจรับ"
                  sub={tfInTransit.map(t =>
                    `${t.tfRef || t.id.slice(-6)} · ${t.fromWarehouseName||'คลัง'} → ${t.toWarehouseName||'ร้าน'}`
                  ).join('\n')}
                  badge={tfInTransit.length} badgeBg="#DCFCE7" badgeColor="#16A34A"
                  onClick={() => tfInTransit.length === 1 ? openReceiveTransfer(tfInTransit[0]) : undefined}
                />
              )}

              {/* Low stock */}
              {lowAlerts.length > 0 && (
                <div>
                  <div style={{ display: 'flex', gap: 6, overflowX: 'auto',
                    scrollbarWidth: 'none', paddingBottom: 2 }}>
                    {lowAlerts.map(a => (
                      <div key={a.id} style={{ flexShrink: 0, borderRadius: 20, padding: '5px 12px',
                        fontSize: 11, fontWeight: 700,
                        background: a.currentQty <= 0 ? '#FEE2E2' : '#FFF7ED',
                        border: `1px solid ${a.currentQty <= 0 ? '#FCA5A5' : '#FDE68A'}`,
                        color: a.currentQty <= 0 ? '#DC2626' : '#92600A' }}>
                        {a.currentQty <= 0 ? '🔴' : '🟡'} {a.itemName}
                        <span style={{ opacity: 0.7, marginLeft: 4 }}>เหลือ {a.currentQty} {a.unit||''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* EXP alerts */}
              {expAlerts.length > 0 && (
                <div style={{ display: 'flex', gap: 6, overflowX: 'auto',
                  scrollbarWidth: 'none', paddingBottom: 2 }}>
                  {expAlerts.map(lot => (
                    <div key={lot.id} style={{ flexShrink: 0, borderRadius: 20, padding: '5px 12px',
                      fontSize: 11, fontWeight: 700,
                      background: lot.daysLeft <= 0 ? '#FEE2E2' : '#FFFBEB',
                      border: `1px solid ${lot.daysLeft <= 0 ? '#FCA5A5' : '#FDE68A'}`,
                      color: lot.daysLeft <= 0 ? '#DC2626' : '#B45309' }}>
                      🗓️ {lot.itemName}
                      <span style={{ opacity: 0.7, marginLeft: 4 }}>
                        {lot.daysLeft <= 0 ? 'หมดอายุแล้ว' : `EXP ${lot.daysLeft}d`}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* ทุกอย่างปกติ */}
              {!hasAny && (
                <div style={{ padding: '10px 14px', background: '#F9FAFB',
                  border: '1px dashed var(--border2)', borderRadius: 12,
                  fontSize: 12, color: 'var(--txt3)', textAlign: 'center' }}>
                  ✅ ทุกอย่างปกติ ไม่มีรายการรอดำเนินการ
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Action grid */}
      <div>
        <div className="section-label">ทำรายการ</div>
        <div style={{ padding: '0 1rem' }}>
          <div className="action-grid">
            <button className="action-btn" onClick={() => isEditor() && setReceiveOpen(true)}>
              <span className="action-icon">📥</span>
              <span className="action-label">รับสินค้า</span>
            </button>
            <button className="action-btn" onClick={() => isEditor() && openTransferBlank()}>
              <span className="action-icon">🚚</span>
              <span className="action-label">โอนสินค้า</span>
            </button>
            <button className="action-btn" onClick={() => setRefillOpen(true)}>
              <span className="action-icon" style={{ position: 'relative' }}>
                🔔
                {alerts.length > 0 && (
                  <span style={{
                    position: 'absolute', top: -4, right: -4, background: 'var(--red)',
                    color: '#fff', borderRadius: '50%', width: 14, height: 14,
                    fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>{alerts.length}</span>
                )}
              </span>
              <span className="action-label">แจ้งเติมของ</span>
            </button>
            <button className="action-btn" onClick={() => setWasteOpen(true)}>
              <span className="action-icon">🗑️</span>
              <span className="action-label">บันทึกของเสีย</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Section: ใบแจ้งเติมของรอดำเนินการ (Owner เท่านั้น) ── */}
      {isOwner() && refillRequests.filter(r => r.status === 'pending').length > 0 && (() => {
        const pendingRFs = refillRequests.filter(r => r.status === 'pending')
          .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)) // เก่าสุดขึ้นก่อน
        const allSelected  = pendingRFs.every(r => rfSelectedIds.has(r.id))
        const someSelected = rfSelectedIds.size > 0
        const selectedRFs  = pendingRFs.filter(r => rfSelectedIds.has(r.id))

        function toggleRF(id) {
          setRfSelectedIds(prev => {
            const next = new Set(prev)
            next.has(id) ? next.delete(id) : next.add(id)
            return next
          })
        }
        function toggleAll() {
          setRfSelectedIds(allSelected ? new Set() : new Set(pendingRFs.map(r => r.id)))
        }

        return (
          <div>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 1rem' }}>
              <div className="section-label" style={{ padding: 0, marginBottom: 0, flex: 1 }}>
                📋 คำร้องแจ้งเติมของ
              </div>
              <span style={{ background: '#FFF7ED', color: '#D97706', border: '1px solid #FDE68A',
                borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
                {pendingRFs.length} ใบ
              </span>
              {/* เลือกทั้งหมด */}
              <button onClick={toggleAll}
                style={{ fontSize: 11, fontWeight: 600, color: allSelected ? '#DC2626' : '#6B7280',
                  background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>
                {allSelected ? '✗ ยกเลิกทั้งหมด' : '☑ เลือกทั้งหมด'}
              </button>
            </div>

            {/* RF Cards */}
            <div style={{ padding: '8px 1rem 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pendingRFs.map(rf => {
                const sel = rfSelectedIds.has(rf.id)
                // แปลงเวลา
                const ts = rf.createdAt?.seconds
                  ? new Date(rf.createdAt.seconds * 1000)
                  : null
                const timeStr = ts
                  ? `${ts.getDate()}/${ts.getMonth()+1} เวลา ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')} น.`
                  : ''
                return (
                  <div key={rf.id}
                    onClick={() => toggleRF(rf.id)}
                    style={{ background: sel ? '#FFFBEB' : '#fff', borderRadius: 14,
                      border: `2px solid ${sel ? '#F59E0B' : '#FDE68A'}`,
                      boxShadow: sel ? '0 0 0 3px rgba(245,158,11,0.15)' : '0 1px 4px rgba(0,0,0,0.05)',
                      padding: 14, cursor: 'pointer', transition: 'all 0.15s' }}>

                    {/* Row 1: Checkbox + Ref + Badge + 🗑️ */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      {/* Checkbox custom */}
                      <div style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${sel ? '#F59E0B' : '#D1D5DB'}`,
                        background: sel ? '#F59E0B' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, transition: 'all 0.15s' }}>
                        {sel && <span style={{ color: '#fff', fontSize: 13, fontWeight: 900 }}>✓</span>}
                      </div>
                      <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, flex: 1 }}>
                        {rf.rfRef || rf.id.slice(-8)}
                      </span>
                      <span style={{ fontSize: 10, background: '#FFF7ED', color: '#D97706',
                        border: '1px solid #FDE68A', borderRadius: 6, padding: '2px 7px', fontWeight: 700 }}>
                        🟡 รอดำเนินการ
                      </span>
                      {/* ปุ่มลบ */}
                      <button
                        onClick={e => { e.stopPropagation()
                          setRfDeleteId(rfDeleteId === rf.id ? null : rf.id)
                          setRfDeleteReason('')
                        }}
                        style={{ width: 28, height: 28, border: 'none', borderRadius: 8, cursor: 'pointer',
                          background: rfDeleteId === rf.id ? '#FEE2E2' : '#F3F4F6',
                          color: rfDeleteId === rf.id ? '#DC2626' : '#9CA3AF',
                          fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0, transition: 'all 0.15s' }}>
                        🗑️
                      </button>
                    </div>

                    {/* Row 2: แจ้งโดย + เวลา */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8, marginLeft: 32 }}>
                      <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>
                        👤 {rf.requestedBy || 'ไม่ระบุ'}
                      </span>
                      {timeStr && (
                        <span style={{ fontSize: 11, color: '#6B7280' }}>· 🕐 {timeStr}</span>
                      )}
                    </div>

                    {/* Row 3: รายการ chips */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginLeft: 32, marginBottom: rfDeleteId === rf.id ? 10 : 0 }}>
                      {(rf.items || []).map((it, i) => (
                        <span key={i} style={{ fontSize: 11, background: '#F3F4F6',
                          borderRadius: 6, padding: '3px 8px', border: '1px solid #E5E7EB' }}>
                          {it.img} {it.itemName}
                          {it.qty > 0
                            ? <span style={{ color: '#D97706', fontWeight: 700 }}> ×{it.qty} {it.unit}</span>
                            : null}
                        </span>
                      ))}
                    </div>

                    {/* Inline Delete Confirm */}
                    {rfDeleteId === rf.id && (
                      <div onClick={e => e.stopPropagation()}
                        style={{ marginTop: 4, padding: '10px 12px', background: '#FEF2F2',
                          borderRadius: 10, border: '1px solid #FECACA' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#DC2626', marginBottom: 6 }}>
                          🗑️ ยืนยันยกเลิกคำร้อง {rf.rfRef}?
                        </div>
                        <input
                          value={rfDeleteReason}
                          onChange={e => setRfDeleteReason(e.target.value)}
                          placeholder="ระบุเหตุผล (ต้องกรอก)..."
                          style={{ width: '100%', padding: '8px 10px', borderRadius: 8,
                            border: '1.5px solid #FCA5A5', fontSize: 12, fontFamily: 'Sarabun',
                            outline: 'none', boxSizing: 'border-box', marginBottom: 8 }}
                        />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => { setRfDeleteId(null); setRfDeleteReason('') }}
                            style={{ flex: 1, padding: '8px 0', border: '1px solid #D1D5DB',
                              borderRadius: 8, background: '#fff', fontSize: 12,
                              fontWeight: 600, cursor: 'pointer', color: '#6B7280' }}>
                            ยกเลิก
                          </button>
                          <button
                            onClick={() => deleteRF(rf.id, rf.rfRef, rfDeleteReason)}
                            disabled={rfDeleting || rfDeleteReason.trim().length < 3}
                            style={{ flex: 2, padding: '8px 0', border: 'none', borderRadius: 8,
                              background: rfDeleteReason.trim().length < 3 ? '#FCA5A5' : '#DC2626',
                              color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                              opacity: rfDeleting ? 0.6 : 1 }}>
                            {rfDeleting ? 'กำลังลบ...' : '🗑️ ยืนยันลบ + บันทึก Log'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* ── Sticky bar: สร้างใบโอนรวม ── */}
            {someSelected && (
              <div style={{ position: 'sticky', bottom: 72, zIndex: 50,
                margin: '12px 1rem 0', padding: '12px 16px',
                background: 'linear-gradient(135deg,#DC2626,#B91C1C)',
                borderRadius: 14, boxShadow: '0 4px 16px rgba(220,38,38,0.4)',
                display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#fff', fontWeight: 700, fontSize: 14, fontFamily: 'Prompt' }}>
                    🚚 สร้างใบโอนรวม ({rfSelectedIds.size} ใบ)
                  </div>
                  <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 2 }}>
                    {selectedRFs.reduce((n, r) => n + (r.items?.length || 0), 0)} รายการ
                    {rfSelectedIds.size > 1 && ' · รวม qty อัตโนมัติ'}
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); openTransferFromRFs(selectedRFs) }}
                  style={{ background: '#fff', color: '#DC2626', border: 'none', borderRadius: 10,
                    padding: '10px 18px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                    fontFamily: 'Prompt', flexShrink: 0 }}>
                  ดำเนินการ →
                </button>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Section: ใบโอนกำลังนำส่ง (in_transit) ── */}
      {transfers.filter(t => t.status === 'in_transit').length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 1rem' }}>
            <div className="section-label" style={{ padding: 0, marginBottom: 0, flex: 1 }}>🚚 กำลังนำส่ง</div>
            <span style={{ background: '#DCFCE7', color: '#16A34A', borderRadius: 10,
              padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
              {transfers.filter(t => t.status === 'in_transit').length}
            </span>
          </div>
          <div style={{ padding: '8px 1rem 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {transfers.filter(t => t.status === 'in_transit').map(tf => {
              const fromName = warehouses.find(w => w.id === tf.fromWarehouseId)?.name || tf.fromWarehouseName || 'คลัง'
              const toName   = warehouses.find(w => w.id === tf.toWarehouseId)?.name   || tf.toWarehouseName   || 'ร้าน'
              return (
                <div key={tf.id} style={{ background: '#fff', borderRadius: 14,
                  border: '1px solid #BBF7D0', boxShadow: '0 1px 4px rgba(0,0,0,0.05)', padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13 }}>{tf.tfRef || tf.id.slice(-6)}</span>
                    <span style={{ fontSize: 10, background: '#DCFCE7', color: '#16A34A',
                      borderRadius: 6, padding: '2px 7px', fontWeight: 700 }}>🟢 กำลังนำส่ง</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--txt2)', marginBottom: 6 }}>
                    {fromName} → {toName}
                    {tf.driver ? <span style={{ color: '#6B7280' }}> · 🧑 {tf.driver}</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 10 }}>
                    {tf.items?.length || 0} รายการ
                    {tf.items?.slice(0, 3).map((it, i) => (
                      <span key={i} style={{ marginLeft: 6 }}>{it.img}{it.itemName}</span>
                    ))}
                    {(tf.items?.length || 0) > 3 && <span> +{tf.items.length - 3}</span>}
                  </div>
                  {isEditor() && (
                    <button onClick={() => openReceiveTransfer(tf)}
                      style={{ width: '100%', background: '#16A34A', color: '#fff', border: 'none',
                        borderRadius: 10, padding: '10px 0', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                      📋 ตรวจรับสินค้า
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Modal: รับสินค้า */}
      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="รับสินค้าเข้าคลัง"
        lockClose={!!(rcv.itemId || rcv.qty)}
        footer={rcv.itemId && <button className="btn-primary" onClick={submitReceive} disabled={receiveSaving}>{receiveSaving ? 'กำลังบันทึก...' : '✅ บันทึกรับสินค้า'}</button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Item Picker */}
          <ItemPickerGrid items={items} balances={balances} warehouseId={null}
            selectedId={rcv.itemId}
            onSelect={item => setRcv(r => ({ ...r, itemId: item.id, unit: item.unitBuy || item.unitBase || '' }))} />
          {/* Form — แสดงเมื่อเลือกแล้ว */}
          {rcv.itemId && (() => {
            const item = items.find(i => i.id === rcv.itemId)
            return (
              <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{item?.img} {item?.name}</div>
                {/* หน่วย chips */}
                <div>
                  <label className="fi-label">หน่วย</label>
                  <UnitChips
                    opts={getUnitOptions(items.find(i => i.id === rcv.itemId))}
                    selected={rcv.unit}
                    onChange={u => setRcv(r => ({ ...r, unit: u }))}
                  />
                </div>
                {/* จำนวน + วันที่รับ side-by-side */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                  <div>
                    <label className="fi-label">จำนวน</label>
                    <PosQty
                      value={parseFloat(rcv.qty) || 0}
                      onChange={v => setRcv(r => ({ ...r, qty: String(v) }))}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="fi-label">วันที่รับ</label>
                    <input className="fi" type="date" value={rcv.receiveDate}
                      onChange={e => setRcv(r => ({ ...r, receiveDate: e.target.value }))} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label className="fi-label">MFG</label>
                    <input className="fi" type="date" value={rcv.mfgDate}
                      onChange={e => setRcv(r => ({ ...r, mfgDate: e.target.value }))} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="fi-label">EXP</label>
                    <input className="fi" type="date" value={rcv.expDate}
                      onChange={e => setRcv(r => ({ ...r, expDate: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <label className="fi-label">แหล่งที่มา</label>
                  <select className="fi" value={rcv.source} onChange={e => setRcv(r => ({ ...r, source: e.target.value }))}>
                    {sources.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            )
          })()}
        </div>
      </Modal>

      {/* ══ Modal: แจ้งเติมของ (Staff กดแจ้ง → จบ) ══ */}
      <Modal open={refillOpen}
        onClose={() => { setRefillOpen(false); setRefillSelected(new Set()); setRefillQtys({}); setRefillUnits({}); setRefillCat('low') }}
        title="แจ้งเติมของ"
        lockClose={refillSelected.size > 0}
        footer={
          <button className="btn-primary" onClick={submitRefill}
            disabled={refillSaving || refillSelected.size === 0}
            style={{ opacity: refillSaving || refillSelected.size === 0 ? 0.5 : 1 }}>
            {refillSaving ? 'กำลังส่ง...' : `🔔 แจ้งเติมของ (${refillSelected.size} รายการ)`}
          </button>
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, color: '#92400E', background: '#FFF7ED',
            borderRadius: 10, padding: '8px 12px', border: '1px solid #FDE68A' }}>
            🔔 เลือกรายการที่ต้องการเติม · คลังจะดำเนินการสร้างใบโอนให้
          </div>
          {(() => {
            const allItems = items.filter(item => {
              const qty = balances.filter(b => b.itemId === item.id).reduce((s,b) => s+(b.qty||0),0)
              return qty <= (item.minQty || 0)
            })
            const others = items.filter(item => {
              const qty = balances.filter(b => b.itemId === item.id).reduce((s,b) => s+(b.qty||0),0)
              return qty > (item.minQty || 0)
            })
            const renderItem = (item) => {
              const stockQty = balances.filter(b => b.itemId === item.id).reduce((s,b) => s+(b.qty||0),0)
              const checked  = refillSelected.has(item.id)
              const isOut    = stockQty <= 0
              const currentQty  = refillQtys[item.id]  || 0
              // unit options
              const unitOpts = []
              if (item.unitBuy && !unitOpts.find(u=>u===item.unitBuy)) unitOpts.push(item.unitBuy)
              if (item.unitUse && !unitOpts.find(u=>u===item.unitUse)) unitOpts.push(item.unitUse)
              if (item.unitSub && !unitOpts.find(u=>u===item.unitSub)) unitOpts.push(item.unitSub)
              if (unitOpts.length === 0 && item.unitBase) unitOpts.push(item.unitBase)
              const selectedUnit = refillUnits[item.id] || unitOpts[0] || ''

              function toggleCheck(e) {
                e.stopPropagation()
                setRefillSelected(prev => {
                  const n = new Set(prev)
                  if (n.has(item.id)) { n.delete(item.id) } else {
                    n.add(item.id)
                    // set default qty=1 if not set
                    setRefillQtys(q => q[item.id] ? q : { ...q, [item.id]: 1 })
                  }
                  return n
                })
              }
              function setQty(val) {
                const v = Math.max(0, val)
                setRefillQtys(q => ({ ...q, [item.id]: v }))
              }

              return (
                <div key={item.id} style={{ borderRadius: 14,
                  border: `2px solid ${checked ? '#FCD34D' : 'var(--border)'}`,
                  background: checked ? '#FFFBEB' : '#fff',
                  overflow: 'hidden', transition: 'border-color .15s' }}>

                  {/* Row บน: checkbox + info */}
                  <div onClick={toggleCheck}
                    style={{ display: 'flex', alignItems: 'center', gap: 10,
                      padding: '11px 14px', cursor: 'pointer' }}>
                    {/* Checkbox */}
                    <div style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0,
                      border: `2px solid ${checked ? '#F59E0B' : 'var(--border2)'}`,
                      background: checked ? '#F59E0B' : '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all .15s' }}>
                      {checked && <span style={{ color: '#fff', fontSize: 14, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                    </div>
                    <span style={{ fontSize: 22, flexShrink: 0 }}>{item.img || '📦'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{item.name}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2,
                        color: isOut ? '#DC2626' : stockQty < (item.minQty||0) ? '#D97706' : '#6B7280' }}>
                        {isOut ? '🔴 หมดแล้ว' : `🟡 เหลือ ${stockQty} ${item.unitBase||''}`}
                      </div>
                    </div>
                  </div>

                  {/* Row ล่าง: stepper + unit (เฉพาะเมื่อเลือก) */}
                  {checked && (
                    <div onClick={e => e.stopPropagation()}
                      style={{ borderTop: '1px solid #FDE68A', padding: '10px 14px',
                        display: 'flex', alignItems: 'center', gap: 10, background: '#FFFDF0' }}>

                      {/* Unit pills */}
                      {unitOpts.length > 1 && (
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                          {unitOpts.map(u => {
                            const active = selectedUnit === u
                            return (
                              <button key={u} onClick={() => setRefillUnits(r => ({ ...r, [item.id]: u }))}
                                style={{ border: `1.5px solid ${active ? '#F59E0B' : 'var(--border2)'}`,
                                  background: active ? '#F59E0B' : '#fff',
                                  color: active ? '#fff' : 'var(--txt2)',
                                  borderRadius: 8, padding: '4px 10px',
                                  fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                                {u}
                              </button>
                            )
                          })}
                        </div>
                      )}
                      {unitOpts.length === 1 && (
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#D97706',
                          background: '#FEF3C7', borderRadius: 8, padding: '4px 10px', flexShrink: 0 }}>
                          {selectedUnit}
                        </span>
                      )}

                      {/* Spacer */}
                      <div style={{ flex: 1 }} />

                      {/* POS Stepper */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 0,
                        border: '1.5px solid #FCD34D', borderRadius: 12, overflow: 'hidden' }}>
                        <button onClick={() => setQty(currentQty - 1)}
                          style={{ width: 38, height: 38, border: 'none', background: currentQty > 0 ? '#FEF3C7' : '#F3F4F6',
                            color: currentQty > 0 ? '#D97706' : '#C7C7CC',
                            fontSize: 20, fontWeight: 700, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          −
                        </button>
                        <div style={{ minWidth: 44, textAlign: 'center',
                          fontFamily: 'Prompt', fontWeight: 700, fontSize: 18,
                          color: currentQty > 0 ? '#1C1C1E' : '#C7C7CC',
                          padding: '0 4px', background: '#fff' }}>
                          {currentQty || 0}
                        </div>
                        <button onClick={() => setQty(currentQty + 1)}
                          style={{ width: 38, height: 38, border: 'none', background: '#F59E0B',
                            color: '#fff', fontSize: 20, fontWeight: 700, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          +
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            }
            // หมวดหมู่ที่มีใน items ทั้งหมด
            const CAT_ORDER = ['ผลไม้','แยม','ไซรัป','ท็อปปิ้ง','วัตถุดิบ','บรรจุภัณฑ์','อื่นๆ']
            const CAT_EMOJI = { ผลไม้:'🍋', แยม:'🍓', ไซรัป:'🍯', ท็อปปิ้ง:'💎', วัตถุดิบ:'🥛', บรรจุภัณฑ์:'🥤', อื่นๆ:'🔖' }
            const availableCats = ['low', ...CAT_ORDER.filter(c =>
              items.some(i => (i.category || 'อื่นๆ') === c)
            )]

            // กรองตาม tab
            const displayItems = refillCat === 'low'
              ? allItems                                             // stock ต่ำ/หมด
              : items.filter(i => (i.category || 'อื่นๆ') === refillCat)

            // นับ selected ต่อ cat
            function selCount(cat) {
              if (cat === 'low') return [...refillSelected].filter(id => allItems.find(i=>i.id===id)).length
              return [...refillSelected].filter(id => {
                const it = items.find(i=>i.id===id)
                return (it?.category||'อื่นๆ') === cat
              }).length
            }

            return (
              <>
                {/* Category chips */}
                <div style={{ display: 'flex', gap: 6, overflowX: 'auto',
                  scrollbarWidth: 'none', paddingBottom: 4, marginBottom: 4 }}>
                  {availableCats.map(cat => {
                    const active = refillCat === cat
                    const cnt = selCount(cat)
                    return (
                      <button key={cat} onClick={() => setRefillCat(cat)}
                        style={{ flexShrink: 0, border: 'none', borderRadius: 20,
                          padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                          transition: 'all .15s',
                          background: active ? '#F59E0B' : '#F3F4F6',
                          color: active ? '#fff' : '#6B7280',
                          display: 'flex', alignItems: 'center', gap: 5 }}>
                        {cat === 'low'
                          ? <><span>⚠️</span> ต่ำ/หมด</>
                          : <><span>{CAT_EMOJI[cat]||'📦'}</span> {cat}</>
                        }
                        {cnt > 0 && (
                          <span style={{ background: active ? 'rgba(255,255,255,0.35)' : '#F59E0B',
                            color: active ? '#fff' : '#fff', borderRadius: 10,
                            minWidth: 18, height: 18, fontSize: 10, fontWeight: 700,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>
                            {cnt}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* รายการตาม tab */}
                {displayItems.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 24, color: 'var(--txt3)', fontSize: 13 }}>
                    {refillCat === 'low' ? '✅ ไม่มีรายการ stock ต่ำ' : 'ไม่มีรายการในหมวดนี้'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {refillCat === 'low' && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#DC2626',
                        letterSpacing: 0.5, paddingLeft: 2 }}>⚠️ STOCK ต่ำ / หมด</div>
                    )}
                    {displayItems.map(renderItem)}
                  </div>
                )}
              </>
            )
          })()}
        </div>
      </Modal>

      {/* ══ Modal: สร้างใบโอน + นำส่ง (Owner/คลัง) ══ */}
      <Modal open={transferOpen} onClose={() => { setTransferOpen(false); setTfAddMode(false) }}
        lockClose={true}
        title="สร้างใบโอน + นำส่ง"
        footer={
          <button className="btn-primary" onClick={submitTransfer}
            disabled={transferSaving || !tfr.fromWH || !tfr.toWH || transferItems.length === 0}
            style={{ opacity: (transferSaving || !tfr.fromWH || !tfr.toWH || transferItems.length === 0) ? 0.5 : 1 }}>
            {transferSaving ? 'กำลังบันทึก...' : `🚚 สร้าง + นำส่งเลย (${transferItems.length} รายการ)`}
          </button>
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* ── RF Import Picker ── */}
          {(() => {
            const pendingRFs = refillRequests.filter(r => r.status === 'pending')
            if (pendingRFs.length === 0) return null
            return (
              <div style={{ borderRadius: 12, border: '1.5px solid #FCD34D',
                background: '#FFFBEB', overflow: 'hidden' }}>
                {/* Header แถบกด toggle */}
                <div onClick={() => setTfrRFExpand(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8,
                    padding: '9px 12px', cursor: 'pointer' }}>
                  <span style={{ fontSize: 14 }}>📋</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#92400E', flex: 1 }}>
                    นำเข้าจากใบแจ้งเติมของ ({pendingRFs.length} ใบรอ)
                  </span>
                  {tfrRFImport.size > 0 && (
                    <span style={{ background: '#F59E0B', color: '#fff', borderRadius: 10,
                      padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>
                      เลือก {tfrRFImport.size}
                    </span>
                  )}
                  <span style={{ color: '#D97706', fontSize: 13,
                    transform: tfrRFExpand ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>▾</span>
                </div>

                {tfrRFExpand && (
                  <div style={{ borderTop: '1px solid #FDE68A', padding: '8px 10px',
                    display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {pendingRFs.map(rf => {
                      const sel = tfrRFImport.has(rf.id)
                      const ts  = rf.requestedAt?.seconds
                        ? new Date(rf.requestedAt.seconds * 1000) : null
                      const timeStr = ts
                        ? `${ts.getDate()}/${ts.getMonth()+1} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`
                        : ''
                      return (
                        <div key={rf.id}
                          onClick={() => setTfrRFImport(prev => {
                            const n = new Set(prev)
                            n.has(rf.id) ? n.delete(rf.id) : n.add(rf.id)
                            return n
                          })}
                          style={{ display: 'flex', alignItems: 'center', gap: 8,
                            padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
                            background: sel ? '#FEF3C7' : '#fff',
                            border: `1.5px solid ${sel ? '#F59E0B' : '#E5E7EB'}`,
                            transition: 'all .15s' }}>
                          {/* Checkbox */}
                          <div style={{ width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                            border: `2px solid ${sel ? '#F59E0B' : '#D1D5DB'}`,
                            background: sel ? '#F59E0B' : '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {sel && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#1C1C1E' }}>
                              {rf.rfRef || rf.id.slice(-8)}
                            </div>
                            <div style={{ fontSize: 10, color: '#6B7280' }}>
                              👤 {rf.requestedBy || '-'}
                              {timeStr && ` · 🕐 ${timeStr}`}
                              {` · ${rf.items?.length || 0} รายการ`}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                    {/* ปุ่ม นำเข้า */}
                    <button
                      disabled={tfrRFImport.size === 0}
                      onClick={() => {
                        const selected = pendingRFs.filter(r => tfrRFImport.has(r.id))
                        mergeRFsIntoItems(selected)
                        setTfr(t => ({
                          ...t,
                          _rfIds:  selected.map(r => r.id),
                          _rfRefs: selected.map(r => r.rfRef || r.id.slice(-6)),
                        }))
                        setTfrRFExpand(false)
                      }}
                      style={{ marginTop: 4, padding: '9px 0', border: 'none', borderRadius: 10,
                        background: tfrRFImport.size > 0 ? '#F59E0B' : '#E5E7EB',
                        color: tfrRFImport.size > 0 ? '#fff' : '#9CA3AF',
                        fontWeight: 700, fontSize: 13, cursor: tfrRFImport.size > 0 ? 'pointer' : 'default',
                        fontFamily: 'Prompt' }}>
                      {tfrRFImport.size > 0
                        ? `📥 นำเข้า ${tfrRFImport.size} ใบ → เพิ่มรายการในใบโอน`
                        : 'เลือกใบแจ้งเติมของก่อน'}
                    </button>
                  </div>
                )}
              </div>
            )
          })()}

          {/* คลัง */}
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label className="fi-label">จากคลัง</label>
              <select className="fi" value={tfr.fromWH} onChange={e => setTfr(t => ({ ...t, fromWH: e.target.value }))}>
                <option value="">เลือก</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="fi-label">ไปยัง</label>
              <select className="fi" value={tfr.toWH} onChange={e => setTfr(t => ({ ...t, toWH: e.target.value }))}>
                <option value="">เลือก</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="fi-label">คนนำส่ง</label>
            <input className="fi" placeholder="ระบุชื่อคนนำส่ง" value={tfr.driver}
              onChange={e => setTfr(t => ({ ...t, driver: e.target.value }))} />
          </div>

          {/* รายการ */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <label className="fi-label" style={{ margin: 0 }}>วัตถุดิบที่จะส่ง</label>
              <button onClick={() => setTfAddMode(m => !m)}
                style={{ border: 'none', background: tfAddMode ? '#FEE2E2' : 'var(--red-p)',
                  color: tfAddMode ? '#DC2626' : 'var(--red)', borderRadius: 8,
                  padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                {tfAddMode ? '✕ ปิด' : '+ เพิ่มรายการ'}
              </button>
            </div>
            {tfAddMode && (
              <div style={{ marginBottom: 10 }}>
                <ItemPickerGrid items={items} balances={balances}
                  warehouseId={tfr.fromWH || null} selectedId={null}
                  filterFn={(item, stock) => stock > 0 && !transferItems.find(t => t.itemId === item.id)}
                  onSelect={item => {
                    const unitOpts = []
                    if (item.unitUse)  unitOpts.push(item.unitUse)
                    if (item.unitBase && !unitOpts.includes(item.unitBase)) unitOpts.push(item.unitBase)
                    setTransferItems(prev => [...prev, {
                      itemId: item.id, itemName: item.name, img: item.img || '📦',
                      category: item.category || 'อื่นๆ',
                      qty: '', unit: unitOpts[0] || '', unitOpts,
                    }])
                    setTfAddMode(false)
                  }} />
              </div>
            )}
            {transferItems.length === 0 ? (
              <div style={{ background: '#F9FAFB', border: '1px dashed var(--border2)',
                borderRadius: 10, padding: 14, textAlign: 'center', fontSize: 12, color: 'var(--txt3)' }}>
                กด "+ เพิ่มรายการ" หรือมาจากใบแจ้งเติมของ
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {transferItems.map((it, idx) => {
                  // หา unitOpts จาก item master หรือที่เก็บไว้ใน it.unitOpts
                  const master   = items.find(i => i.id === it.itemId)
                  const unitOpts = it.unitOpts?.length
                    ? it.unitOpts
                    : (() => {
                        const opts = []
                        if (master?.unitUse)  opts.push(master.unitUse)
                        if (master?.unitBase && !opts.includes(master.unitBase)) opts.push(master.unitBase)
                        if (opts.length === 0 && it.unit) opts.push(it.unit)
                        return opts
                      })()
                  const stockInFrom = tfr.fromWH
                    ? balances.filter(b => b.itemId === it.itemId && b.warehouseId === tfr.fromWH)
                        .reduce((s,b) => s + (b.qty||0), 0)
                    : null
                  return (
                    <div key={idx} style={{ background: '#F9FAFB', borderRadius: 12,
                      border: '1px solid var(--border)', padding: '10px 12px' }}>
                      {/* Row 1: emoji + ชื่อ + ลบ */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <span style={{ fontSize: 22, flexShrink: 0 }}>{it.img}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{it.itemName}</div>
                          {stockInFrom !== null && (
                            <div style={{ fontSize: 10, color: stockInFrom > 0 ? '#6B7280' : '#DC2626', marginTop: 1 }}>
                              {stockInFrom > 0 ? `คลังมี ${stockInFrom} ${it.unit}` : '⚠️ ไม่มีในคลัง'}
                            </div>
                          )}
                        </div>
                        <button onClick={() => setTransferItems(prev => prev.filter((_,i) => i !== idx))}
                          style={{ border: 'none', background: '#FEE2E2', color: '#DC2626',
                            borderRadius: 8, width: 30, height: 30, fontSize: 15, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✕</button>
                      </div>
                      {/* Row 2: unit chips + POS stepper */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        {unitOpts.length > 0 && (
                          <UnitChips
                            opts={unitOpts.map(u => ({ value: u, label: u, sub: '' }))}
                            selected={it.unit}
                            onChange={u => setTransferItems(prev => prev.map((p,i) =>
                              i === idx ? { ...p, unit: u } : p))}
                          />
                        )}
                        <PosQty
                          value={parseFloat(it.qty) || 0}
                          onChange={v => setTransferItems(prev => prev.map((p,i) =>
                            i === idx ? { ...p, qty: String(v) } : p))}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* ══ Modal: ตรวจรับสินค้า (หน้าร้านติ๊กทีละรายการ) ══ */}
      {receivingTF && (
        <Modal open={receiveTransferOpen}
          onClose={() => { setReceiveTransferOpen(false); setReceivingTF(null) }}
          title={`ตรวจรับ ${receivingTF.tfRef || ''}`}
          lockClose={receivingChecked.size > 0}
          footer={
            <button
              onClick={confirmReceiveTransfer}
              disabled={receivingSaving || receivingChecked.size < (receivingTF.items?.length || 0)}
              style={{ width: '100%', background: '#16A34A', color: '#fff', border: 'none',
                borderRadius: 14, padding: '13px 0', fontSize: 15, fontWeight: 700, cursor: 'pointer',
                opacity: receivingSaving || receivingChecked.size < (receivingTF.items?.length || 0) ? 0.45 : 1 }}>
              {receivingSaving ? 'กำลังบันทึก...'
                : receivingChecked.size < (receivingTF.items?.length || 0)
                  ? `ติ๊กอีก ${(receivingTF.items?.length||0) - receivingChecked.size} รายการ`
                  : '✅ ยืนยันรับสินค้าครบถ้วน'}
            </button>
          }>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Info bar */}
            <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, padding: '10px 14px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#166534', marginBottom: 2 }}>
                🚚 {receivingTF.fromWarehouseName} → {receivingTF.toWarehouseName}
              </div>
              {receivingTF.driver && (
                <div style={{ fontSize: 11, color: '#6B7280' }}>คนนำส่ง: {receivingTF.driver}</div>
              )}
              <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                ติ๊กถูก {receivingChecked.size}/{receivingTF.items?.length || 0} รายการ
              </div>
            </div>

            {/* Progress bar */}
            <div style={{ background: '#F3F4F6', borderRadius: 99, height: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: '#16A34A', transition: 'width .3s',
                width: `${(receivingChecked.size / (receivingTF.items?.length || 1)) * 100}%` }} />
            </div>

            {/* Items grouped by category */}
            {(() => {
              const allItems = receivingTF.items || []
              // group by category
              const grouped = {}
              allItems.forEach((it, idx) => {
                const cat = it.category || 'อื่นๆ'
                if (!grouped[cat]) grouped[cat] = []
                grouped[cat].push({ ...it, _idx: idx })
              })
              const catOrder = ['ผลไม้','แยม','ไซรัป','ท็อปปิ้ง','วัตถุดิบ','บรรจุภัณฑ์','อื่นๆ']
              const sortedCats = Object.keys(grouped).sort((a,b) =>
                (catOrder.indexOf(a) === -1 ? 99 : catOrder.indexOf(a)) -
                (catOrder.indexOf(b) === -1 ? 99 : catOrder.indexOf(b)))
              return sortedCats.map(cat => (
                <div key={cat}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--txt3)',
                    letterSpacing: 0.8, marginBottom: 6, paddingBottom: 4,
                    borderBottom: '1px solid #F3F4F6' }}>
                    {cat.toUpperCase()}
                  </div>
                  {grouped[cat].map(it => {
                    const ticked = receivingChecked.has(it._idx)
                    return (
                      <div key={it._idx}
                        onClick={() => setReceivingChecked(prev => {
                          const n = new Set(prev); ticked ? n.delete(it._idx) : n.add(it._idx); return n
                        })}
                        style={{ display: 'flex', alignItems: 'center', gap: 12,
                          background: ticked ? '#F0FDF4' : '#fff',
                          border: `2px solid ${ticked ? '#86EFAC' : 'var(--border)'}`,
                          borderRadius: 12, padding: '11px 14px', marginBottom: 7,
                          cursor: 'pointer', transition: 'all .15s' }}>
                        {/* Tick circle */}
                        <div style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                          border: `2px solid ${ticked ? '#16A34A' : 'var(--border2)'}`,
                          background: ticked ? '#16A34A' : '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {ticked && <span style={{ color: '#fff', fontSize: 14, fontWeight: 700 }}>✓</span>}
                        </div>
                        <span style={{ fontSize: 22, flexShrink: 0 }}>{it.img || '📦'}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 700,
                            color: ticked ? '#16A34A' : 'var(--txt)',
                            textDecoration: ticked ? 'none' : 'none' }}>
                            {it.itemName}
                          </div>
                          <div style={{ fontSize: 12, color: ticked ? '#16A34A' : 'var(--txt2)',
                            fontWeight: 700, marginTop: 1 }}>
                            {it.qty} {it.unit}
                          </div>
                        </div>
                        {ticked && <span style={{ fontSize: 18, flexShrink: 0 }}>✅</span>}
                      </div>
                    )
                  })}
                </div>
              ))
            })()}
          </div>
        </Modal>
      )}

      {/* Modal: Bell — การแจ้งเตือน */}
      <Modal open={bellOpen} onClose={() => setBellOpen(false)} title="🔔 การแจ้งเตือน">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {alertCount === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: 13 }}>
              ✅ ไม่มีการแจ้งเตือนขณะนี้
            </div>
          ) : (
            <>
              {/* Low stock alerts */}
              {unresolvedAlerts.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    สต็อกต่ำ / หมด
                  </div>
                  {unresolvedAlerts.map(a => (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: a.currentQty <= 0 ? '#FEE2E2' : '#FFF7ED',
                      border: `1px solid ${a.currentQty <= 0 ? '#FCA5A5' : '#FCD34D'}`,
                      borderRadius: 10, padding: '10px 12px', marginBottom: 6 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: a.currentQty <= 0 ? '#DC2626' : '#92600A' }}>
                          {a.currentQty <= 0 ? '🔴' : '🟡'} {a.itemName}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
                          เหลือ {a.currentQty} {a.unit || ''} · ขั้นต่ำ {a.minQty || 0} {a.unit || ''}
                        </div>
                      </div>
                      <button onClick={() => dismissAlert(a.id)}
                        style={{ background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 8,
                          padding: '6px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', flexShrink: 0, marginLeft: 8 }}>
                        รับทราบ
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* EXP alerts */}
              {expAlerts.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    ใกล้หมดอายุ (ภายใน 7 วัน)
                  </div>
                  {expAlerts.map(lot => (
                    <div key={lot.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: lot.daysLeft <= 0 ? '#FEE2E2' : '#FFFBEB',
                      border: `1px solid ${lot.daysLeft <= 0 ? '#FCA5A5' : '#FDE68A'}`,
                      borderRadius: 10, padding: '10px 12px', marginBottom: 6 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: lot.daysLeft <= 0 ? '#DC2626' : '#B45309' }}>
                          {lot.daysLeft <= 0 ? '🔴' : '🟠'} {lot.itemName}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
                          LOT: {lot.id} · {lot.daysLeft <= 0 ? 'หมดอายุแล้ว' : `เหลือ ${lot.daysLeft} วัน`}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: lot.daysLeft <= 0 ? '#DC2626' : '#D97706',
                        flexShrink: 0, marginLeft: 8 }}>
                        {lot.daysLeft <= 0 ? 'หมดอายุ' : `${lot.daysLeft}d`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </Modal>

      {/* Modal: บันทึกของเสีย */}
      <Modal open={wasteOpen} onClose={() => setWasteOpen(false)} title="บันทึกของเสีย"
        lockClose={!!(waste.itemId || waste.qty)}
        footer={waste.itemId && <button className="btn-primary" onClick={saveWaste} disabled={wasteSaving}>
          {wasteSaving ? 'กำลังบันทึก...' : '💾 บันทึก'}
        </button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* ประเภท */}
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ v: 'fruit_daily', l: '🍋 ผลไม้ระหว่างวัน' }, { v: 'closing', l: '🌙 ปิดร้าน' }].map(({ v, l }) => (
              <button key={v} onClick={() => setWaste(w => ({ ...w, type: v, itemId: '', qty: '', unit: '' }))}
                style={{ flex: 1, padding: '8px 0', borderRadius: 10, border: `2px solid ${waste.type === v ? 'var(--red)' : 'var(--border)'}`,
                  background: waste.type === v ? 'var(--red-p)' : 'var(--surf)',
                  fontSize: 12, fontWeight: waste.type === v ? 700 : 500, cursor: 'pointer',
                  color: waste.type === v ? 'var(--red)' : 'var(--txt2)' }}>
                {l}
              </button>
            ))}
          </div>
          {/* Item Picker */}
          {(() => {
            // ผลไม้ระหว่างวัน → บังคับเฉพาะ ส้ม + มะนาว
            const FRUIT_DAILY_NAMES = ['ส้ม', 'มะนาว']
            const filterFn = waste.type === 'fruit_daily'
              ? (item) => FRUIT_DAILY_NAMES.some(n => item.name?.trim() === n)
              : (item) => item.wasteMode === true

            const available = items.filter(i => filterFn(i))
            if (waste.type === 'fruit_daily') {
              return available.length === 0 ? (
                <div style={{ background: '#FFF7ED', borderRadius: 10, padding: 12, fontSize: 12, color: '#92600A', textAlign: 'center' }}>
                  ⚠️ ไม่พบ "ส้ม" หรือ "มะนาว" ในระบบ
                </div>
              ) : (
                /* fruit_daily: แสดงแค่ 2 ปุ่ม — ไม่ต้องใช้ full picker */
                <div style={{ display: 'flex', gap: 10 }}>
                  {available.map(item => {
                    const sel = waste.itemId === item.id
                    return (
                      <button key={item.id} onClick={() => {
                        const defaultUnit = item.unitUse || item.unitBase || ''
                        setWaste(w => ({ ...w, itemId: item.id, unit: defaultUnit, qty: '' }))
                      }} style={{ flex: 1, border: `2px solid ${sel ? 'var(--red)' : 'var(--border)'}`,
                        background: sel ? 'var(--red-p)' : 'var(--surf)', borderRadius: 14,
                        padding: '14px 8px', cursor: 'pointer', textAlign: 'center',
                        transition: 'all .15s', position: 'relative' }}>
                        {sel && <span style={{ position: 'absolute', top: 6, right: 8, fontSize: 14 }}>✅</span>}
                        <div style={{ fontSize: 30 }}>{item.img || '🍊'}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, marginTop: 6, color: sel ? 'var(--red)' : 'var(--txt)' }}>
                          {item.name}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )
            }
            // ปิดร้าน — full picker
            return available.length === 0 ? (
              <div style={{ background: '#FFF7ED', borderRadius: 10, padding: 12, fontSize: 12, color: '#92600A', textAlign: 'center' }}>
                ⚠️ ยังไม่มีวัตถุดิบที่เปิด Waste Mode<br />ไปตั้งค่าที่ ตั้งค่า → วัตถุดิบ
              </div>
            ) : (
              <ItemPickerGrid items={items} balances={balances} warehouseId={null}
                selectedId={waste.itemId}
                filterFn={filterFn}
                onSelect={item => {
                  const defaultUnit = item.unitUse || item.unitBase || ''
                  setWaste(w => ({ ...w, itemId: item.id, unit: defaultUnit, qty: '' }))
                }} />
            )
          })()}
          {/* Form */}
          {waste.itemId && (() => {
            const item = items.find(i => i.id === waste.itemId)
            const unitOpts = getUnitOptions(item)
            const selectedUnit = waste.unit || unitOpts[0]?.value || ''
            const estimatedCost = calcWasteCost(item, selectedUnit, waste.qty)
            const hasCost = estimatedCost > 0

            return (
              <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Unit selector */}
                <div>
                  <label className="fi-label">หน่วย</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {unitOpts.map(opt => {
                      const active = selectedUnit === opt.value
                      return (
                        <button key={opt.value}
                          onClick={() => setWaste(w => ({ ...w, unit: opt.value }))}
                          style={{ border: `2px solid ${active ? 'var(--red)' : 'var(--border)'}`,
                            background: active ? 'var(--red-p)' : 'var(--surf)',
                            borderRadius: 10, padding: '6px 14px', cursor: 'pointer',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                          <span style={{ fontSize: 13, fontWeight: 700,
                            color: active ? 'var(--red)' : 'var(--txt)' }}>{opt.label}</span>
                          {opt.sub ? <span style={{ fontSize: 9.5, color: active ? 'var(--red)' : 'var(--txt3)' }}>{opt.sub}</span> : null}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* qty + cost preview */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <PosQty value={parseFloat(waste.qty)||0} onChange={v => setWaste(w => ({...w, qty: String(v)}))} />
                  {/* มูลค่า */}
                  <div style={{ flexShrink: 0, marginBottom: 1 }}>
                    <div style={{
                      background: hasCost ? '#FEF3C7' : 'var(--border)',
                      borderRadius: 10, padding: '8px 12px', minWidth: 90, textAlign: 'center',
                      border: `1px solid ${hasCost ? '#FDE68A' : 'transparent'}`,
                      transition: 'all .2s'
                    }}>
                      <div style={{ fontSize: 9, color: hasCost ? '#92600A' : 'var(--txt3)', fontWeight: 700, marginBottom: 1 }}>มูลค่า</div>
                      <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'Prompt',
                        color: hasCost ? '#92600A' : 'var(--txt3)' }}>
                        {hasCost ? `฿${estimatedCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                      </div>
                    </div>
                  </div>
                </div>

                {/* cost source hint */}
                {!cmCosts[item?.name] && (
                  <div style={{ fontSize: 10, color: '#D97706', background: '#FFF7ED',
                    borderRadius: 8, padding: '5px 10px' }}>
                    ⚠️ ไม่พบข้อมูลต้นทุนจาก Cost Manager — มูลค่าจะบันทึกเป็น ฿0
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      </Modal>
    </div>
  )
}
