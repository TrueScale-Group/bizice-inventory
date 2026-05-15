import { useState, useEffect } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, orderBy, doc, updateDoc, addDoc, serverTimestamp } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { useSession } from '../hooks/useSession'
import { toDateKey, toThaiDate, toThaiShort, toThaiTime } from '../utils/formatDate'

const SUB_TABS = [
  { id: 'daily',   label: '📋 รายวัน' },
  { id: 'weekly',  label: '📅 สัปดาห์+เดือน' },
  { id: 'waste',   label: '🗑️ ของเสีย' },
  { id: 'analyze', label: '📊 วิเคราะห์' },
]

const WEEK_TABS = ['สัปดาห์นี้', 'สัปดาห์ก่อน', 'เดือนนี้', '3 เดือน']
const WASTE_TABS = ['7 วัน', '30 วัน', 'เดือนนี้']

export default function Report() {
  const { isOwner } = useSession()
  const [sub, setSub] = useState('daily')
  const [date, setDate] = useState(toDateKey())
  const [weekTab, setWeekTab] = useState(0)
  const [wasteTab, setWasteTab] = useState(0)
  const [cutLogs, setCutLogs] = useState([])
  const [wasteLogs, setWasteLogs] = useState([])
  const [transfers, setTransfers] = useState([])
  const [auditLogs, setAuditLogs] = useState([])
  const [deleteModal, setDeleteModal] = useState(null)
  const [deleteReason, setDeleteReason] = useState('')
  const [pinUnlocked, setPinUnlocked] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinError, setPinError] = useState(false)
  const [wasteTarget, setWasteTarget] = useState(8)
  const [targetModal, setTargetModal] = useState(false)

  useEffect(() => {
    const q = query(collection(db, 'cut_stock_logs'), where('date', '==', date))
    const unsub = onSnapshot(q, snap => setCutLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
    return () => unsub()
  }, [date])

  useEffect(() => {
    const q = query(collection(db, 'waste_logs'), where('date', '==', date))
    const unsub = onSnapshot(q, snap => setWasteLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
    return () => unsub()
  }, [date])

  useEffect(() => {
    const q = query(collection(db, 'transfer_orders'), where('status', '==', 'received'))
    const unsub = onSnapshot(q, snap => setTransfers(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
    return () => unsub()
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'audit_logs'), orderBy('timestamp', 'desc'))
    const unsub = onSnapshot(q, snap => setAuditLogs(snap.docs.slice(0, 20).map(d => ({ id: d.id, ...d.data() }))))
    return () => unsub()
  }, [])

  const activeLogs = cutLogs.filter(l => !l.deletedAt)
  const totalCost = activeLogs.reduce((s, l) => s + (l.totalCost || 0), 0)
  const fruitWaste = wasteLogs.filter(l => l.type === 'fruit_daily')
  const closingWaste = wasteLogs.filter(l => l.type === 'closing')

  async function softDelete(log) {
    if (deleteReason.trim().length < 5) return
    await updateDoc(doc(db, 'cut_stock_logs', log.id), {
      deletedAt: serverTimestamp(), deleteReason: deleteReason.trim(),
      deletedBy: window._bizSession?.phone || ''
    })
    await addDoc(collection(db, 'audit_logs'), {
      action: 'delete_log', staffPhone: window._bizSession?.phone || '',
      staffName: window._bizSession?.name || '', warehouseId: log.warehouseId || '',
      detail: `ลบ log ${log.id}: ${deleteReason.trim()}`, timestamp: serverTimestamp()
    })
    setDeleteModal(null)
    setDeleteReason('')
  }

  function checkPin(pin) {
    if (pin === '1234') { setPinUnlocked(true); setPinError(false) }
    else { setPinError(true); setTimeout(() => { setPinError(false); setPinInput('') }, 800) }
  }

  return (
    <div className="page-pad">
      {/* Topbar */}
      <div className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', height: 'auto', paddingBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span className="topbar-title">รายงาน</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button style={{ background: 'var(--bg)', border: '1.5px solid var(--border2)',
              borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              📤 Export
            </button>
            <ConnectionStatus />
          </div>
        </div>
        {/* Sub-tabs */}
        <div style={{ display: 'flex', gap: 4, overflowX: 'auto', scrollbarWidth: 'none' }}>
          {SUB_TABS.map(t => (
            <button key={t.id} onClick={() => setSub(t.id)}
              style={{ flexShrink: 0, border: 'none', borderRadius: 8, padding: '5px 10px',
                fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: sub === t.id ? 'var(--red)' : 'var(--bg)',
                color: sub === t.id ? '#fff' : 'var(--txt2)' }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab A: รายวัน ── */}
      {sub === 'daily' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Date selector */}
          <div style={{ padding: '0 1rem', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>📅 {toThaiDate(new Date(date.replace(/-/g, '/')))}</span>
            <input type="date" className="fi" style={{ flex: 1, fontSize: 13 }}
              value={date} onChange={e => setDate(e.target.value)} />
          </div>

          {/* KPI */}
          <div style={{ padding: '0 1rem' }}>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">ต้นทุนวัตถุดิบ</div>
                <div className="kpi-val" style={{ fontSize: 18, color: 'var(--red)' }}>฿{totalCost.toLocaleString()}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">ครั้งตัดสต็อก</div>
                <div className="kpi-val">{activeLogs.length}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">ของเสียวันนี้</div>
                <div className="kpi-val" style={{ fontSize: 18 }}>฿{wasteLogs.reduce((s, l) => s + (l.totalCost || 0), 0).toLocaleString()}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">ใบโอน</div>
                <div className="kpi-val">{transfers.length}</div>
              </div>
            </div>
          </div>

          {/* ผลไม้เสียระหว่างวัน */}
          <div>
            <div className="section-label">🍋 ผลไม้เสียระหว่างวัน</div>
            <div style={{ padding: '0 1rem' }}>
              <div className="card" style={{ padding: 14 }}>
                {fruitWaste.length === 0
                  ? <div style={{ color: 'var(--txt3)', fontSize: 13, textAlign: 'center', padding: 8 }}>ไม่มีข้อมูล</div>
                  : fruitWaste.map(w => (
                    <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0',
                      borderBottom: '1px solid var(--border)' }}>
                      <span style={{ fontSize: 13 }}>{w.itemName}</span>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{w.qty} {w.unit} · ฿{(w.totalCost || 0).toLocaleString()}</span>
                    </div>
                  ))
                }
              </div>
            </div>
          </div>

          {/* ประวัติตัดสต็อก */}
          <div>
            <div className="section-label">✂️ ประวัติตัดสต็อก</div>
            <div style={{ padding: '0 1rem', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activeLogs.length === 0 && (
                <div className="card" style={{ padding: 20, textAlign: 'center', color: 'var(--txt3)' }}>ยังไม่มีการตัดสต็อก</div>
              )}
              {activeLogs.map(log => (
                <div key={log.id} className="card" style={{ padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{log.staffName}</div>
                      <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                        {log.items?.length} รายการ · {log.timestamp ? toThaiTime(log.timestamp) : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14 }}>
                        ฿{(log.totalCost || 0).toLocaleString()}
                      </span>
                      {isOwner() && (
                        <button style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: '#DC2626' }}
                          onClick={() => setDeleteModal(log)}>🗑️</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ของเสียปิดร้าน */}
          <div style={{ marginTop: 8 }}>
            <div className="section-label">🌙 ของเสียปิดร้าน</div>
            <div style={{ padding: '0 1rem' }}>
              <div className="card" style={{ padding: 14 }}>
                {closingWaste.length === 0
                  ? <div style={{ color: 'var(--txt3)', fontSize: 13, textAlign: 'center', padding: 8 }}>ไม่มีข้อมูล</div>
                  : closingWaste.map(w => (
                    <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ fontSize: 13 }}>{w.itemName}</span>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{w.qty} {w.unit}</span>
                    </div>
                  ))
                }
              </div>
            </div>
          </div>

          {/* Audit log */}
          <div>
            <div className="section-label">🔍 Audit Log</div>
            <div style={{ padding: '0 1rem' }}>
              <div className="card">
                {auditLogs.slice(0, 8).map(l => (
                  <div key={l.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{l.staffName}</div>
                      <div style={{ fontSize: 11, color: 'var(--txt3)' }}>{l.action} · {l.detail}</div>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--txt3)' }}>
                      {l.timestamp ? toThaiTime(l.timestamp) : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab B: สัปดาห์+เดือน ── */}
      {sub === 'weekly' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ padding: '0 1rem' }}>
            <div className="segment">
              {WEEK_TABS.map((t, i) => (
                <button key={t} className={`seg-btn${weekTab === i ? ' active' : ''}`} onClick={() => setWeekTab(i)}>{t}</button>
              ))}
            </div>
          </div>
          <div style={{ padding: '0 1rem', textAlign: 'center', color: 'var(--txt3)', fontSize: 14, paddingTop: 40 }}>
            📊 ข้อมูลสัปดาห์จะแสดงเมื่อมีประวัติการตัดสต็อก
          </div>
        </div>
      )}

      {/* ── Tab C: ของเสีย ── */}
      {sub === 'waste' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ padding: '0 1rem' }}>
            <div className="segment">
              {WASTE_TABS.map((t, i) => (
                <button key={t} className={`seg-btn${wasteTab === i ? ' active' : ''}`} onClick={() => setWasteTab(i)}>{t}</button>
              ))}
            </div>
          </div>

          {/* Target Waste % */}
          <div style={{ padding: '0 1rem' }}>
            <div className="card" style={{ padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt2)' }}>🎯 เป้า Waste % ของต้นทุน</div>
                  <div style={{ fontFamily: 'Prompt', fontSize: 24, fontWeight: 700 }}>{wasteTarget}%</div>
                </div>
                <button style={{ border: '1.5px solid var(--border2)', borderRadius: 8, padding: '5px 10px',
                  fontSize: 12, fontWeight: 700, background: 'var(--bg)', cursor: 'pointer' }}
                  onClick={() => setTargetModal(true)}>แก้ไข</button>
              </div>
              <div className="progress-bar" style={{ height: 8 }}>
                <div className="progress-fill ok" style={{ width: '40%' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--txt3)', marginTop: 4 }}>
                <span>Actual: กำลังคำนวณ...</span>
                <span>เป้า: {wasteTarget}%</span>
              </div>
            </div>
          </div>

          {/* Block 1: ผลไม้เสียระหว่างวัน */}
          <div>
            <div className="section-label">🍋 ผลไม้เสียระหว่างวัน</div>
            <div style={{ padding: '0 1rem' }}>
              <div className="card" style={{ padding: 14 }}>
                <div style={{ color: 'var(--txt3)', fontSize: 13 }}>กำลังโหลดข้อมูล...</div>
              </div>
            </div>
          </div>

          {/* Block 2: ของเสียปิดร้าน */}
          <div style={{ marginTop: 12 }}>
            <div className="section-label">🌙 ของเสียปิดร้าน</div>
            <div style={{ padding: '0 1rem' }}>
              <div className="card" style={{ padding: 14 }}>
                <div style={{ color: 'var(--txt3)', fontSize: 13 }}>กำลังโหลดข้อมูล...</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab D: วิเคราะห์ (PIN) ── */}
      {sub === 'analyze' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 1rem' }}>
          {!pinUnlocked ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, paddingTop: 40 }}>
              <div style={{ fontSize: 32 }}>🔐</div>
              <div style={{ fontFamily: 'Prompt', fontSize: 18, fontWeight: 700 }}>ใส่ PIN เพื่อเข้าถึง</div>
              <div style={{ display: 'flex', gap: 12 }}>
                {[0, 1, 2, 3].map(i => (
                  <div key={i} style={{ width: 16, height: 16, borderRadius: '50%',
                    background: pinInput.length > i ? (pinError ? '#DC2626' : 'var(--red)') : 'var(--border2)',
                    transition: 'background 0.2s' }} />
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, width: '100%', maxWidth: 240 }}>
                {[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map((k, i) => (
                  <button key={i} onClick={() => {
                    if (k === '⌫') { setPinInput(p => p.slice(0, -1)); return }
                    if (k === '') return
                    const next = pinInput + k
                    setPinInput(next)
                    if (next.length === 4) checkPin(next)
                  }}
                    style={{ height: 56, border: '1.5px solid var(--border2)', borderRadius: 12,
                      fontSize: 20, fontWeight: 700, background: k === '' ? 'transparent' : 'var(--surf)',
                      cursor: k === '' ? 'default' : 'pointer', fontFamily: 'Prompt',
                      borderColor: k === '' ? 'transparent' : undefined }}>
                    {k}
                  </button>
                ))}
              </div>
              {pinError && <div style={{ color: '#DC2626', fontSize: 13, fontWeight: 700 }}>PIN ไม่ถูกต้อง</div>}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Food Cost Dashboard */}
              <div style={{ background: 'linear-gradient(135deg,#15803D,#166534)', borderRadius: 16, padding: 18, color: '#fff' }}>
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>Actual Food Cost % · เดือนนี้</div>
                <div style={{ fontFamily: 'Prompt', fontSize: 36, fontWeight: 700 }}>—%</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>ต้นทุน ฿— ÷ รายรับ ฿—</div>
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                  {[['Theoretical', '—%'], ['เป้า', '≤30%'], ['เดือนก่อน', '—%']].map(([l, v]) => (
                    <div key={l} style={{ flex: 1, background: 'rgba(255,255,255,0.15)', borderRadius: 8, padding: '6px 8px' }}>
                      <div style={{ fontSize: 10, opacity: 0.8 }}>{l}</div>
                      <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 15 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ color: 'var(--txt3)', fontSize: 13, textAlign: 'center', paddingTop: 16 }}>
                ข้อมูลจะแสดงเมื่อมีประวัติรายรับจาก Daily Income
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delete modal */}
      {deleteModal && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setDeleteModal(null)}>
          <div className="bottom-sheet">
            <div className="sheet-handle" />
            <div className="sheet-header">
              <span className="sheet-title">ลบ Log รายการ</span>
              <button className="sheet-close" onClick={() => setDeleteModal(null)}>✕</button>
            </div>
            <div className="sheet-body">
              <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--txt2)' }}>
                กรุณาระบุเหตุผล (อย่างน้อย 5 ตัวอักษร)
              </div>
              <textarea className="fi" rows={3} placeholder="เหตุผลในการลบ..."
                value={deleteReason} onChange={e => setDeleteReason(e.target.value)}
                style={{ resize: 'none' }} />
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setDeleteModal(null)}>ยกเลิก</button>
                <button className="btn-primary" style={{ flex: 1, background: '#DC2626' }}
                  onClick={() => softDelete(deleteModal)}
                  disabled={deleteReason.trim().length < 5}>
                  ยืนยันลบ
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
