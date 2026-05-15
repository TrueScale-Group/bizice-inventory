import { useState, useEffect } from 'react'
import { db } from '../firebase'
import { collection, onSnapshot, doc, getDoc, setDoc, addDoc, updateDoc,
         deleteDoc, serverTimestamp } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { Modal } from '../components/Modal'
import { useSession } from '../hooks/useSession'
import { Toast } from '../components/Toast'

const HUB = 'https://truescale-group.github.io/mixue-ice-sakon/'
const ITEM_CATS = ['แยม', 'ผลไม้', 'ไซรัป', 'ท็อปปิ้ง', 'วัตถุดิบ', 'บรรจุภัณฑ์']
const WH_COLORS = ['#E31E24', '#1D4ED8', '#16A34A', '#D97706', '#7C3AED', '#0284C7']
const EMOJIS = ['🍓', '🍋', '🍯', '💎', '🥛', '🥤', '🍎', '🥭', '🍊', '🍇', '🥥', '📦']
const TPL_ICONS = ['☀️', '🎉', '⚡', '🌙', '🏖️', '🔥']

export default function Settings() {
  const { name, phone, role, isOwner } = useSession()
  const [lastSync, setLastSync] = useState('')
  const [settings, setSettings] = useState({})
  const [warehouses, setWarehouses] = useState([])
  const [items, setItems] = useState([])
  const [templates, setTemplates] = useState([])
  const [toast, setToast] = useState('')

  // Modal states
  const [whModal, setWhModal] = useState(false)
  const [itemModal, setItemModal] = useState(false)
  const [tplModal, setTplModal] = useState(false)
  const [intModal, setIntModal] = useState(false)
  const [openingModal, setOpeningModal] = useState(false)
  const [pinModal, setPinModal] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [editWH, setEditWH] = useState(null)
  const [editTpl, setEditTpl] = useState(null)

  // Forms
  const [whForm, setWhForm] = useState({ name: '', type: 'branch', color: WH_COLORS[0] })
  const [itemForm, setItemForm] = useState({
    name: '', category: ITEM_CATS[0], img: '📦', unitBase: '', unitUse: '',
    unitConversion: '', minQty: '', maxQty: '', wasteMode: false
  })
  const [tplForm, setTplForm] = useState({ name: '', icon: '☀️', items: [] })
  const [pinForm, setPinForm] = useState({ old: '', newPin: '', confirm: '' })
  const [notifLow, setNotifLow] = useState(true)
  const [notifWaste, setNotifWaste] = useState(false)
  const [expDays, setExpDays] = useState(7)

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'warehouses'), snap => {
      setWarehouses(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    const u2 = onSnapshot(collection(db, 'items'), snap => {
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    const u3 = onSnapshot(collection(db, 'quick_templates'), snap => {
      setTemplates(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0)))
    })
    const u4 = onSnapshot(doc(db, 'app_settings', 'inventory_settings'), snap => {
      if (snap.exists()) {
        const d = snap.data()
        setSettings(d)
        setNotifLow(d.notifLowStock !== false)
        setNotifWaste(d.notifWasteOverThreshold === true)
        setExpDays(d.expWarningDays || 7)
        setLastSync(new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }))
      }
    })
    return () => { u1(); u2(); u3(); u4() }
  }, [])

  async function saveWH() {
    if (!whForm.name) return
    const data = { ...whForm, active: true, isMain: whForm.type === 'main', branchCode: '', createdAt: serverTimestamp() }
    if (editWH) await updateDoc(doc(db, 'warehouses', editWH.id), data)
    else await addDoc(collection(db, 'warehouses'), data)
    setWhModal(false); setEditWH(null); setWhForm({ name: '', type: 'branch', color: WH_COLORS[0] })
    setToast('✅ บันทึกคลังสินค้าเรียบร้อย')
  }

  async function saveItem() {
    if (!itemForm.name) return
    const data = { ...itemForm, minQty: parseFloat(itemForm.minQty) || 0, maxQty: parseFloat(itemForm.maxQty) || 0 }
    if (editItem) await updateDoc(doc(db, 'items', editItem.id), data)
    else await addDoc(collection(db, 'items'), { ...data, createdAt: serverTimestamp() })
    setItemModal(false); setEditItem(null)
    setItemForm({ name: '', category: ITEM_CATS[0], img: '📦', unitBase: '', unitUse: '', unitConversion: '', minQty: '', maxQty: '', wasteMode: false })
    setToast('✅ บันทึกวัตถุดิบเรียบร้อย')
  }

  async function saveTpl() {
    if (!tplForm.name) return
    const data = { ...tplForm, createdBy: phone, order: templates.length }
    if (editTpl) await updateDoc(doc(db, 'quick_templates', editTpl.id), data)
    else await addDoc(collection(db, 'quick_templates'), data)
    setTplModal(false); setEditTpl(null); setTplForm({ name: '', icon: '☀️', items: [] })
    setToast('✅ บันทึก Quick Template เรียบร้อย')
  }

  async function saveSettings(updates) {
    await setDoc(doc(db, 'app_settings', 'inventory_settings'), updates, { merge: true })
  }

  async function forceRefresh() {
    setToast('🔄 กำลัง refresh...')
    window.location.reload()
  }

  function logout() {
    localStorage.removeItem('bizice_session')
    window.location.replace(HUB)
  }

  const initials = name ? name.trim().slice(-2) : '??'

  const SettingRow = ({ icon, title, right, onClick, danger }) => (
    <div className="setting-row" onClick={onClick}
      style={danger ? { color: '#DC2626' } : {}}>
      <div className="setting-left">
        <span className="setting-icon">{icon}</span>
        <span className="setting-title" style={danger ? { color: '#DC2626' } : {}}>{title}</span>
      </div>
      {right !== undefined ? right : <span className="setting-arrow">›</span>}
    </div>
  )

  return (
    <div className="page-pad">
      {toast && <Toast message={toast} onDone={() => setToast('')} />}

      {/* Topbar */}
      <div className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', height: 'auto', paddingBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="topbar-title">ตั้งค่า</span>
          <ConnectionStatus />
        </div>
        {lastSync && (
          <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>อัปเดตล่าสุด {lastSync} น.</div>
        )}
      </div>

      {/* Profile card */}
      <div style={{ padding: '0 1rem' }}>
        <div style={{ background: 'linear-gradient(135deg,var(--red),var(--red-d))', borderRadius: 16,
          padding: 18, color: '#fff', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(255,255,255,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'Prompt', fontWeight: 700, fontSize: 20 }}>
            {initials}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 17 }}>{name}</div>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
              {role === 'owner' ? '👑 Owner' : '👤 Staff'} · {phone}
            </div>
          </div>
          <button style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 8,
            padding: '6px 10px', color: '#fff', fontSize: 13, cursor: 'pointer' }}>✏️</button>
        </div>
      </div>

      {/* กลุ่ม 1 — บัญชี */}
      <div>
        <div className="section-label">บัญชีผู้ใช้</div>
        <div className="card" style={{ margin: '0 1rem' }}>
          <SettingRow icon="🔐" title="เปลี่ยน PIN วิเคราะห์" onClick={() => setPinModal(true)} />
          <SettingRow icon="👥" title="จัดการ Staff"
            right={<span style={{ fontSize: 11, background: 'var(--bg)', border: '1.5px solid var(--border2)',
              borderRadius: 6, padding: '2px 7px', fontWeight: 700, color: 'var(--txt3)' }}>→ Hub</span>}
            onClick={() => window.open(HUB, '_blank')} />
        </div>
      </div>

      {/* กลุ่ม 2 — คลัง+วัตถุดิบ */}
      <div>
        <div className="section-label">คลัง + วัตถุดิบ</div>
        <div className="card" style={{ margin: '0 1rem' }}>
          <SettingRow icon="🏪" title="จัดการคลังสินค้า" onClick={() => setWhModal(true)} />
          <SettingRow icon="📦" title="วัตถุดิบ (Master Data)" onClick={() => setItemModal(true)} />
          {isOwner() && (
            <SettingRow icon="⚡" title="Quick Template" onClick={() => setTplModal(true)} />
          )}
        </div>
      </div>

      {/* กลุ่ม 3 — การแจ้งเตือน */}
      <div>
        <div className="section-label">การแจ้งเตือน</div>
        <div className="card" style={{ margin: '0 1rem' }}>
          <SettingRow icon="📉" title="Stock ต่ำกว่า min"
            right={<button className={`toggle${notifLow ? ' on' : ''}`} onClick={async () => {
              const next = !notifLow; setNotifLow(next)
              await saveSettings({ notifLowStock: next })
            }} />} onClick={() => {}} />
          <SettingRow icon="📅" title={`แจ้งเตือนก่อน EXP ${expDays} วัน`}
            onClick={() => {
              const opts = [7, 14, 30]
              const next = opts[(opts.indexOf(expDays) + 1) % opts.length]
              setExpDays(next); saveSettings({ expWarningDays: next })
            }} />
          <SettingRow icon="🗑️" title="ของเสียเกิน threshold"
            right={<button className={`toggle${notifWaste ? ' on' : ''}`} onClick={async () => {
              const next = !notifWaste; setNotifWaste(next)
              await saveSettings({ notifWasteOverThreshold: next })
            }} />} onClick={() => {}} />
        </div>
      </div>

      {/* กลุ่ม 4 — ระบบ */}
      <div>
        <div className="section-label">ระบบ</div>
        <div className="card" style={{ margin: '0 1rem' }}>
          <SettingRow icon="🔗" title="เชื่อมต่อระบบ" onClick={() => setIntModal(true)} />
          <SettingRow icon="📊" title="Opening Stock" onClick={() => setOpeningModal(true)} />
          <SettingRow icon="📤" title="Export ข้อมูล" onClick={() => setToast('🚧 Coming soon')} />
          <SettingRow icon="🔄" title="รีเฟรชข้อมูล" onClick={forceRefresh} />
        </div>
      </div>

      {/* Danger Zone */}
      {isOwner() && (
        <div>
          <div className="section-label" style={{ color: '#DC2626' }}>Danger Zone</div>
          <div className="card" style={{ margin: '0 1rem' }}>
            <SettingRow icon="🗑️" title="Clear All Data" danger onClick={() => setToast('🚧 ต้องใส่ PIN เพื่อยืนยัน')} />
            <SettingRow icon="🚪" title="ออกจากระบบ" danger onClick={logout} />
          </div>
        </div>
      )}
      {!isOwner() && (
        <div style={{ padding: '0 1rem' }}>
          <button className="btn-secondary" onClick={logout} style={{ marginTop: 8 }}>🚪 ออกจากระบบ</button>
        </div>
      )}

      {/* ── Modal: คลังสินค้า ── */}
      <Modal open={whModal} onClose={() => { setWhModal(false); setEditWH(null) }} title="จัดการคลังสินค้า"
        footer={isOwner() && <button className="btn-primary" onClick={saveWH}>บันทึก</button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* List */}
          {warehouses.map(w => (
            <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: w.color, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{w.name}</div>
                <div style={{ fontSize: 11, color: 'var(--txt3)' }}>{w.type === 'main' ? 'คลังหลัก' : 'สาขา'}</div>
              </div>
              {isOwner() && (
                <button style={{ border: 'none', background: 'none', fontSize: 14, cursor: 'pointer' }}
                  onClick={() => { setEditWH(w); setWhForm({ name: w.name, type: w.type, color: w.color }) }}>
                  ✏️
                </button>
              )}
            </div>
          ))}
          {isOwner() && (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, marginTop: 8 }}>
                {editWH ? `แก้ไข: ${editWH.name}` : '+ เพิ่มคลัง'}
              </div>
              <div>
                <label className="fi-label">ชื่อคลัง</label>
                <input className="fi" value={whForm.name} onChange={e => setWhForm(f => ({ ...f, name: e.target.value }))} placeholder="เช่น ร้าน ITU" />
              </div>
              <div>
                <label className="fi-label">ประเภท</label>
                <select className="fi" value={whForm.type} onChange={e => setWhForm(f => ({ ...f, type: e.target.value }))}>
                  <option value="main">คลังหลัก</option>
                  <option value="branch">สาขา</option>
                </select>
              </div>
              <div>
                <label className="fi-label">สี</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {WH_COLORS.map(c => (
                    <button key={c} onClick={() => setWhForm(f => ({ ...f, color: c }))}
                      style={{ width: 32, height: 32, borderRadius: '50%', background: c, border: whForm.color === c ? '3px solid var(--txt)' : '2px solid transparent', cursor: 'pointer' }} />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* ── Modal: วัตถุดิบ ── */}
      <Modal open={itemModal} onClose={() => { setItemModal(false); setEditItem(null) }} title="วัตถุดิบ (Master Data)"
        footer={isOwner() && <button className="btn-primary" onClick={saveItem}>บันทึก</button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Search */}
          <div className="search-wrap" style={{ margin: 0 }}>
            <span className="search-icon">🔍</span>
            <input className="search-input" placeholder="ค้นหาวัตถุดิบ..." />
          </div>
          {/* List */}
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {items.map(i => (
              <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 20 }}>{i.img}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{i.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--txt3)' }}>{i.category} · {i.unitBase}</div>
                </div>
                {isOwner() && (
                  <button style={{ border: 'none', background: 'none', fontSize: 14, cursor: 'pointer' }}
                    onClick={() => { setEditItem(i); setItemForm({ name: i.name, category: i.category, img: i.img || '📦', unitBase: i.unitBase, unitUse: i.unitUse, unitConversion: i.unitConversion || '', minQty: i.minQty, maxQty: i.maxQty, wasteMode: i.wasteMode || false }) }}>
                    ✏️
                  </button>
                )}
              </div>
            ))}
          </div>
          {isOwner() && (
            <>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{editItem ? `แก้ไข: ${editItem.name}` : '+ เพิ่มวัตถุดิบ'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={{ gridColumn: 'span 2' }}>
                  <label className="fi-label">ชื่อวัตถุดิบ</label>
                  <input className="fi" value={itemForm.name} onChange={e => setItemForm(f => ({ ...f, name: e.target.value }))} placeholder="เช่น แยมสตรอว์เบอร์รี" />
                </div>
                <div>
                  <label className="fi-label">หมวดหมู่</label>
                  <select className="fi" value={itemForm.category} onChange={e => setItemForm(f => ({ ...f, category: e.target.value }))}>
                    {ITEM_CATS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="fi-label">Emoji</label>
                  <select className="fi" value={itemForm.img} onChange={e => setItemForm(f => ({ ...f, img: e.target.value }))}>
                    {EMOJIS.map(e => <option key={e} value={e}>{e}</option>)}
                  </select>
                </div>
                <div>
                  <label className="fi-label">หน่วยหลัก (ซื้อ)</label>
                  <input className="fi" value={itemForm.unitBase} onChange={e => setItemForm(f => ({ ...f, unitBase: e.target.value }))} placeholder="กก." />
                </div>
                <div>
                  <label className="fi-label">หน่วยตัด</label>
                  <input className="fi" value={itemForm.unitUse} onChange={e => setItemForm(f => ({ ...f, unitUse: e.target.value }))} placeholder="ขีด" />
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label className="fi-label">Conversion</label>
                  <input className="fi" value={itemForm.unitConversion} onChange={e => setItemForm(f => ({ ...f, unitConversion: e.target.value }))} placeholder="1 กก. = 10 ขีด" />
                </div>
                <div>
                  <label className="fi-label">Min Stock</label>
                  <input className="fi" type="number" value={itemForm.minQty} onChange={e => setItemForm(f => ({ ...f, minQty: e.target.value }))} />
                </div>
                <div>
                  <label className="fi-label">Max Stock</label>
                  <input className="fi" type="number" value={itemForm.maxQty} onChange={e => setItemForm(f => ({ ...f, maxQty: e.target.value }))} />
                </div>
                <div style={{ gridColumn: 'span 2', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button className={`toggle${itemForm.wasteMode ? ' on' : ''}`}
                    onClick={() => setItemForm(f => ({ ...f, wasteMode: !f.wasteMode }))} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>ติดตามของเสีย (Waste Mode)</span>
                </div>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* ── Modal: Quick Template ── */}
      <Modal open={tplModal} onClose={() => setTplModal(false)} title="Quick Template"
        footer={<button className="btn-primary" onClick={saveTpl}>บันทึก</button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {templates.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 20 }}>{t.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{t.name}</div>
                <div style={{ fontSize: 11, color: 'var(--txt3)' }}>{t.items?.length} รายการ</div>
              </div>
              <button style={{ border: 'none', background: 'none', fontSize: 14, cursor: 'pointer' }}
                onClick={() => setEditTpl(t)}>✏️</button>
            </div>
          ))}
          <div style={{ fontWeight: 700, fontSize: 13 }}>+ สร้าง Template</div>
          <div>
            <label className="fi-label">ชื่อ</label>
            <input className="fi" value={tplForm.name} onChange={e => setTplForm(f => ({ ...f, name: e.target.value }))} placeholder="เช่น เปิดร้านเช้า" />
          </div>
          <div>
            <label className="fi-label">Icon</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {TPL_ICONS.map(ic => (
                <button key={ic} onClick={() => setTplForm(f => ({ ...f, icon: ic }))}
                  style={{ width: 36, height: 36, fontSize: 20, border: tplForm.icon === ic ? '2px solid var(--red)' : '1.5px solid var(--border2)', borderRadius: 8, background: 'var(--bg)', cursor: 'pointer' }}>
                  {ic}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* ── Modal: Integration ── */}
      <Modal open={intModal} onClose={() => setIntModal(false)} title="เชื่อมต่อระบบ">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            { name: '🧮 Cost Manager', desc: 'ราคา/หน่วยวัตถุดิบ', ok: true },
            { name: '💵 Daily Income', desc: 'income_records · Food Cost %', ok: true },
            { name: '🤖 น้องมี่ LINE Bot', desc: 'push_queue · reporter mode', ok: true },
          ].map(sys => (
            <div key={sys.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 14px', background: 'var(--bg)', borderRadius: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{sys.name}</div>
                <div style={{ fontSize: 12, color: 'var(--txt3)' }}>{sys.desc}</div>
              </div>
              <span className={`badge badge-${sys.ok ? 'ok' : 'out'}`}>
                {sys.ok ? '✓ เชื่อมต่อ' : '✕ ไม่ได้เชื่อม'}
              </span>
            </div>
          ))}
          <div style={{ fontSize: 12, color: 'var(--txt3)', marginTop: 4 }}>
            Firebase: mixue-cost-manager · Last sync: {lastSync || '—'}
          </div>
        </div>
      </Modal>

      {/* ── Modal: Opening Stock ── */}
      <Modal open={openingModal} onClose={() => setOpeningModal(false)} title="📊 Opening Stock"
        footer={<button className="btn-primary" onClick={() => setOpeningModal(false)}>บันทึก Opening Stock</button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--txt2)' }}>
            กรอกยอด stock เริ่มต้นสำหรับแต่ละวัตถุดิบ ข้อมูลนี้จะเป็นจุดเริ่มต้นของระบบ
          </div>
          {items.slice(0, 5).map(i => (
            <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18, width: 28 }}>{i.img}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{i.name}</div>
              </div>
              <input className="fi" type="number" style={{ width: 80 }} placeholder="0" />
              <span style={{ fontSize: 12, color: 'var(--txt3)', width: 32 }}>{i.unitBase}</span>
            </div>
          ))}
          {items.length > 5 && (
            <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--txt3)' }}>+ {items.length - 5} รายการ</div>
          )}
        </div>
      </Modal>
    </div>
  )
}
