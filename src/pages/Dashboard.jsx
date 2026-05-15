import { useState, useEffect } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, orderBy, limit,
         doc, getDoc, addDoc, updateDoc, serverTimestamp, Timestamp, writeBatch } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { Modal } from '../components/Modal'
import { Toast } from '../components/Toast'
import { useSession } from '../hooks/useSession'
import { toThaiDate, toThaiTime, lotDateStr, toDateKey } from '../utils/formatDate'
import { sortLotsFIFO } from '../utils/fifo'

const SOURCES = ['ตลาดไท', 'ซัพพลายเออร์', 'โอนจากคลัง', 'ซื้อเอง', 'อื่นๆ']

export default function Dashboard() {
  const { name, isEditor, isOwner } = useSession()
  const [wh, setWh] = useState('all')
  const [warehouses, setWarehouses] = useState([])
  const [kpi, setKpi] = useState({ cost: 0, cuts: 0, low: 0, out: 0 })
  const [alerts, setAlerts] = useState([])
  const [transfers, setTransfers] = useState([])
  const [items, setItems] = useState([])
  const [toast, setToast] = useState('')

  // Modals
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [refillOpen, setRefillOpen] = useState(false)
  const [wasteOpen, setWasteOpen] = useState(false)

  // Receive form
  const [rcv, setRcv] = useState({
    itemId: '', qty: '', unit: '', receiveDate: '', mfgDate: '', expDate: '', source: SOURCES[0]
  })

  // Transfer form
  const [tfr, setTfr] = useState({ fromWH: '', toWH: '', driver: '', lots: [] })
  const [selectedItem, setSelectedItem] = useState(null)
  const [lots, setLots] = useState([])

  // Waste form
  const [waste, setWaste] = useState({ itemId: '', qty: '', unit: '', type: 'fruit_daily' })

  // Load warehouses
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'warehouses'), snap => {
      setWarehouses(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(w => w.active !== false))
    })
    return () => unsub()
  }, [])

  // Load items
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'items'), snap => {
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // Load KPI (today cut logs)
  useEffect(() => {
    const today = toDateKey()
    const q = wh === 'all'
      ? query(collection(db, 'cut_stock_logs'), where('date', '==', today))
      : query(collection(db, 'cut_stock_logs'), where('date', '==', today), where('warehouseId', '==', wh))
    const unsub = onSnapshot(q, snap => {
      const logs = snap.docs.map(d => d.data()).filter(d => !d.deletedAt)
      const cost = logs.reduce((s, l) => s + (l.totalCost || 0), 0)
      setKpi(k => ({ ...k, cost, cuts: logs.length }))
    })
    return () => unsub()
  }, [wh])

  // Load alerts
  useEffect(() => {
    const q = query(collection(db, 'low_stock_alerts'), where('read', '==', false), limit(10))
    const unsub = onSnapshot(q, snap => {
      setAlerts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // Load pending transfers
  useEffect(() => {
    const q = query(collection(db, 'transfer_orders'), where('status', '==', 'pending'), limit(5))
    const unsub = onSnapshot(q, snap => {
      setTransfers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // Load low/out stock
  useEffect(() => {
    const q = wh === 'all'
      ? query(collection(db, 'stock_balances'))
      : query(collection(db, 'stock_balances'), where('warehouseId', '==', wh))
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
    if (!rcv.itemId || !rcv.qty) return
    const item = items.find(i => i.id === rcv.itemId)
    if (!item) return
    const batch = writeBatch(db)
    const lotId = `${rcv.itemId}_${rcv.receiveDate.replace(/\//g, '')}`
    const balId = `${rcv.itemId}_${rcv.itemId}`
    const qty = parseFloat(rcv.qty)

    batch.set(doc(db, 'lot_tracking', lotId), {
      itemId: rcv.itemId, itemName: item.name,
      warehouseId: rcv.fromWH || warehouses[0]?.id || '',
      receiveDate: rcv.receiveDate, mfgDate: rcv.mfgDate, expDate: rcv.expDate,
      totalQty: qty, inWarehouse: qty, inShop: 0, used: 0,
      source: rcv.source, createdAt: serverTimestamp()
    }, { merge: true })

    const balRef = doc(db, 'stock_balances', balId)
    const balSnap = await getDoc(balRef)
    if (balSnap.exists()) {
      batch.update(balRef, { qty: (balSnap.data().qty || 0) + qty, lastUpdated: serverTimestamp() })
    } else {
      batch.set(balRef, { itemId: rcv.itemId, warehouseId: rcv.fromWH || warehouses[0]?.id || '',
        qty, unit: item.unitBase, lastUpdated: serverTimestamp(), lastUpdatedBy: window._bizSession?.phone || '' })
    }

    await batch.commit()
    await addDoc(collection(db, 'stock_movements'), {
      type: 'receive', itemId: rcv.itemId, itemName: item.name,
      warehouseId: rcv.fromWH || warehouses[0]?.id || '',
      qty, unit: item.unitBase, unitUse: item.unitUse, qtyUse: qty,
      staffPhone: window._bizSession?.phone || '', staffName: window._bizSession?.name || '',
      shopName: whName, timestamp: serverTimestamp(), note: `รับจาก ${rcv.source}`
    })
    await addDoc(collection(db, 'audit_logs'), {
      action: 'receive', staffPhone: window._bizSession?.phone || '',
      staffName: window._bizSession?.name || '', warehouseId: rcv.fromWH || '',
      detail: `รับ ${item.name} ${qty} ${item.unitBase}`, timestamp: serverTimestamp()
    })
    setReceiveOpen(false)
    setRcv({ itemId: '', qty: '', unit: '', receiveDate: '', mfgDate: '', expDate: '', source: SOURCES[0] })
    setToast(`✅ รับสินค้า ${item.name} ${qty} ${item.unitBase} เรียบร้อย`)
  }

  async function receiveTransfer(tf) {
    const batch = writeBatch(db)
    tf.items?.forEach(item => {
      const balId = `${item.itemId}_${tf.toWarehouseId}`
      const fromId = `${item.itemId}_${tf.fromWarehouseId}`
      // Adjust balances (simplified — add to destination, reduce from source)
    })
    batch.update(doc(db, 'transfer_orders', tf.id), {
      status: 'received', receivedBy: window._bizSession?.phone || '',
      receivedAt: serverTimestamp()
    })
    await batch.commit()
    setToast(`✅ รับใบโอน #${tf.id} เรียบร้อย`)
  }

  const todayStr = toThaiDate()

  return (
    <div className="page-pad">
      {toast && <Toast message={toast} onDone={() => setToast('')} />}

      {/* Topbar */}
      <div className="topbar">
        <div>
          <div className="topbar-title">แดชบอร์ด</div>
          <div style={{ fontSize: 11, color: 'var(--txt3)' }}>{todayStr}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ConnectionStatus />
          <button style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', position: 'relative' }}>
            🔔
            {alerts.length > 0 && (
              <span style={{
                position: 'absolute', top: -2, right: -4, background: 'var(--red)',
                color: '#fff', borderRadius: '50%', width: 16, height: 16,
                fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700
              }}>{alerts.length}</span>
            )}
          </button>
        </div>
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

      {/* Alert pills */}
      {alerts.length > 0 && (
        <div>
          <div className="section-label">⚠️ แจ้งเตือน</div>
          <div className="chip-row">
            {alerts.map(a => (
              <div key={a.id} className="chip" style={{
                background: a.currentQty <= 0 ? '#FEE2E2' : '#FFF7ED',
                borderColor: a.currentQty <= 0 ? '#DC2626' : '#D97706',
                color: a.currentQty <= 0 ? '#DC2626' : '#92600A'
              }}>
                {a.currentQty <= 0 ? '🔴' : '🟡'} {a.itemName} เหลือ {a.currentQty} {a.unit || ''}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action grid */}
      <div>
        <div className="section-label">ทำรายการ</div>
        <div style={{ padding: '0 1rem' }}>
          <div className="action-grid">
            <button className="action-btn" onClick={() => isEditor() && setReceiveOpen(true)}>
              <span className="action-icon">📥</span>
              <span className="action-label">รับสินค้า</span>
            </button>
            <button className="action-btn" onClick={() => isEditor() && setTransferOpen(true)}>
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

      {/* Pending transfers */}
      {transfers.length > 0 && (
        <div>
          <div className="section-label">📦 ใบโอนรอดำเนินการ</div>
          <div style={{ padding: '0 1rem', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {transfers.map(tf => (
              <div key={tf.id} className="card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14 }}>#{tf.id}</span>
                  <span className="badge badge-low">รอรับ 🟡</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--txt2)', marginBottom: 8 }}>
                  คนนำส่ง: {tf.driver} · {tf.items?.length || 0} รายการ
                </div>
                {isEditor() && (
                  <button className="btn-primary" style={{ padding: '8px 0', fontSize: 13 }}
                    onClick={() => receiveTransfer(tf)}>
                    ✅ รับสินค้า
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modal: รับสินค้า */}
      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="รับสินค้าเข้าคลัง"
        footer={<button className="btn-primary" onClick={submitReceive}>บันทึกรับสินค้า</button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="fi-label">วัตถุดิบ</label>
            <select className="fi" value={rcv.itemId} onChange={e => {
              const item = items.find(i => i.id === e.target.value)
              setRcv(r => ({ ...r, itemId: e.target.value, unit: item?.unitBase || '' }))
            }}>
              <option value="">เลือกวัตถุดิบ</option>
              {items.map(i => <option key={i.id} value={i.id}>{i.img} {i.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label className="fi-label">จำนวน</label>
              <input className="fi" type="number" placeholder="0" value={rcv.qty}
                onChange={e => setRcv(r => ({ ...r, qty: e.target.value }))} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="fi-label">หน่วย</label>
              <input className="fi" value={rcv.unit} readOnly
                style={{ background: 'var(--bg)', color: 'var(--txt3)' }} />
            </div>
          </div>
          <div>
            <label className="fi-label">วันที่รับ / MFG / EXP</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="fi" type="date" placeholder="รับ"
                value={rcv.receiveDate} onChange={e => setRcv(r => ({ ...r, receiveDate: e.target.value }))} />
              <input className="fi" type="date" placeholder="MFG"
                value={rcv.mfgDate} onChange={e => setRcv(r => ({ ...r, mfgDate: e.target.value }))} />
              <input className="fi" type="date" placeholder="EXP"
                value={rcv.expDate} onChange={e => setRcv(r => ({ ...r, expDate: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="fi-label">แหล่งที่มา</label>
            <select className="fi" value={rcv.source} onChange={e => setRcv(r => ({ ...r, source: e.target.value }))}>
              {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
      </Modal>

      {/* Modal: แจ้งเติมของ */}
      <Modal open={refillOpen} onClose={() => setRefillOpen(false)} title="แจ้งเติมของ"
        footer={
          <button className="btn-primary" onClick={() => { setRefillOpen(false); setTransferOpen(true) }}>
            สร้างใบโอน →
          </button>
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {alerts.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--txt3)', padding: '20px 0' }}>
              ไม่มีรายการแจ้งเตือน ✅
            </div>
          )}
          {alerts.map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <input type="checkbox" defaultChecked style={{ width: 18, height: 18 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{a.itemName}</div>
                <div style={{ fontSize: 12, color: 'var(--txt3)' }}>เหลือ {a.currentQty} (min {a.minQty})</div>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      {/* Modal: สร้างใบโอนสินค้า */}
      <Modal open={transferOpen} onClose={() => setTransferOpen(false)} title="สร้างใบโอนสินค้า"
        footer={<button className="btn-primary">สร้างใบโอน</button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: '#FFF7ED', borderRadius: 10, padding: 10, fontSize: 12, color: '#92600A' }}>
            ⚠️ FIFO — Lot เก่าสุดออกก่อน · Lot แดง = stock ไม่พอ
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label className="fi-label">จากคลัง</label>
              <select className="fi" value={tfr.fromWH} onChange={e => setTfr(t => ({ ...t, fromWH: e.target.value }))}>
                <option value="">เลือกคลัง</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="fi-label">ไปยัง</label>
              <select className="fi" value={tfr.toWH} onChange={e => setTfr(t => ({ ...t, toWH: e.target.value }))}>
                <option value="">เลือกคลัง</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="fi-label">คนนำส่ง</label>
            <input className="fi" placeholder="ชื่อคนนำส่ง" value={tfr.driver}
              onChange={e => setTfr(t => ({ ...t, driver: e.target.value }))} />
          </div>
          <div>
            <label className="fi-label">เลือกสินค้า</label>
            <select className="fi" value={selectedItem?.id || ''}
              onChange={e => setSelectedItem(items.find(i => i.id === e.target.value) || null)}>
              <option value="">เลือกวัตถุดิบ</option>
              {items.map(i => <option key={i.id} value={i.id}>{i.img} {i.name}</option>)}
            </select>
          </div>
          {selectedItem && (
            <div style={{ background: 'var(--bg)', borderRadius: 10, padding: 12, fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{selectedItem.emoji} {selectedItem.name}</div>
              <div style={{ color: 'var(--txt3)' }}>หน่วย: {selectedItem.unitBase}</div>
            </div>
          )}
        </div>
      </Modal>

      {/* Modal: บันทึกของเสีย */}
      <Modal open={wasteOpen} onClose={() => setWasteOpen(false)} title="บันทึกของเสีย"
        footer={<button className="btn-primary" onClick={() => setWasteOpen(false)}>บันทึก</button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="fi-label">ประเภท</label>
            <select className="fi" value={waste.type} onChange={e => setWaste(w => ({ ...w, type: e.target.value }))}>
              <option value="fruit_daily">🍋 ผลไม้เสียระหว่างวัน</option>
              <option value="closing">🌙 ของเสียปิดร้าน</option>
            </select>
          </div>
          <div>
            <label className="fi-label">วัตถุดิบ</label>
            <select className="fi" value={waste.itemId} onChange={e => setWaste(w => ({ ...w, itemId: e.target.value }))}>
              <option value="">เลือก</option>
              {items.filter(i => i.wasteMode).map(i => <option key={i.id} value={i.id}>{i.img} {i.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label className="fi-label">จำนวน</label>
              <input className="fi" type="number" value={waste.qty}
                onChange={e => setWaste(w => ({ ...w, qty: e.target.value }))} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="fi-label">หน่วย</label>
              <input className="fi" value={waste.unit}
                onChange={e => setWaste(w => ({ ...w, unit: e.target.value }))} placeholder="ลูก / กรัม / มล." />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
