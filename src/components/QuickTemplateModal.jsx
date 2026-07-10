import { useState, useEffect } from 'react'
import { db } from '../firebase'
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
} from 'firebase/firestore'
import { Modal } from './Modal'
import { COL } from '../constants/collections'
import { beepSuccess } from '../utils/audio'
import { sortByMaster } from '../utils/sortItems'

/**
 * QuickTemplateModal — Owner only. List + Create/Edit/Delete
 *
 * Template schema:
 *   { id, name, icon, items: [{itemId, qty, unitUse}], createdBy, order, createdAt }
 */
export default function QuickTemplateModal({
  open, onClose, items = [], staffPhone, onSuccess,
}) {
  const [templates, setTemplates] = useState([])
  const [editing, setEditing] = useState(null) // null | template object
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    const unsub = onSnapshot(collection(db, COL.QUICK_TEMPLATES), snap => {
      setTemplates(
        snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.order || 0) - (b.order || 0))
      )
    })
    return () => unsub()
  }, [open])

  function startCreate() {
    setEditing({ name: '', icon: '⚡', items: [], order: templates.length })
  }

  async function handleDelete(t) {
    if (!confirm(`ลบ template "${t.name}" ?`)) return
    await deleteDoc(doc(db, COL.QUICK_TEMPLATES, t.id))
    beepSuccess()
    onSuccess?.('🗑️ ลบ template แล้ว')
  }

  async function handleSave() {
    if (!editing?.name?.trim()) return alert('ใส่ชื่อ template')
    if (!editing.items.length) return alert('เลือกรายการอย่างน้อย 1 ชิ้น')
    setLoading(true)
    try {
      const payload = {
        name: editing.name.trim(),
        icon: editing.icon || '⚡',
        items: editing.items.map(i => ({
          itemId: i.itemId, qty: Number(i.qty) || 0, unitUse: i.unitUse || '',
        })),
        order: editing.order || 0,
        createdBy: staffPhone || '',
      }
      if (editing.id) {
        await updateDoc(doc(db, COL.QUICK_TEMPLATES, editing.id), payload)
      } else {
        await addDoc(collection(db, COL.QUICK_TEMPLATES), { ...payload, createdAt: serverTimestamp() })
      }
      beepSuccess()
      onSuccess?.('✅ บันทึก template เรียบร้อย')
      setEditing(null)
    } finally {
      setLoading(false)
    }
  }

  function addItemRow() {
    setEditing(e => ({ ...e, items: [...(e.items || []), { itemId: '', qty: 1, unitUse: '' }] }))
  }
  function updateItemRow(i, patch) {
    setEditing(e => ({
      ...e,
      items: e.items.map((row, idx) => idx === i ? { ...row, ...patch } : row),
    }))
  }
  function removeItemRow(i) {
    setEditing(e => ({ ...e, items: e.items.filter((_, idx) => idx !== i) }))
  }

  return (
    <Modal open={open} onClose={() => { if (!loading) { setEditing(null); onClose?.() } }}
      title={editing ? (editing.id ? 'แก้ไข Quick Template' : 'สร้าง Quick Template') : 'Quick Template'}>
      <div style={{ padding: '0 16px 16px' }}>
        {!editing ? (
          <>
            <button onClick={startCreate}
              style={{ width: '100%', padding: '10px 14px', border: '2px dashed var(--border2)',
                borderRadius: 12, background: 'transparent', color: 'var(--red)',
                fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}>
              ➕ สร้าง Template ใหม่
            </button>
            {templates.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--txt3)', fontSize: 12 }}>
                ยังไม่มี template
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {templates.map(t => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10,
                    padding: 10, background: 'var(--bg)', borderRadius: 10 }}>
                    <span style={{ fontSize: 22 }}>{t.icon || '⚡'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>{t.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                        {(t.items || []).length} รายการ
                      </div>
                    </div>
                    <button onClick={() => setEditing(t)}
                      style={{ padding: '4px 10px', borderRadius: 6, border: 'none',
                        background: '#EFF6FF', color: '#1D4ED8', fontSize: 11, fontWeight: 700,
                        cursor: 'pointer' }}>✏️ แก้</button>
                    <button onClick={() => handleDelete(t)}
                      style={{ padding: '4px 10px', borderRadius: 6, border: 'none',
                        background: '#FEE2E2', color: '#DC2626', fontSize: 11, fontWeight: 700,
                        cursor: 'pointer' }}>🗑️</button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={editing.icon} onChange={e => setEditing(s => ({ ...s, icon: e.target.value }))}
                placeholder="⚡" maxLength={4}
                style={{ width: 60, padding: '10px 12px', borderRadius: 10,
                  border: '1.5px solid var(--border2)', fontSize: 22, textAlign: 'center' }}/>
              <input value={editing.name} onChange={e => setEditing(s => ({ ...s, name: e.target.value }))}
                placeholder="ชื่อ template เช่น 'เปิดร้าน'"
                style={{ flex: 1, padding: '10px 12px', borderRadius: 10,
                  border: '1.5px solid var(--border2)', fontSize: 14, fontWeight: 600 }}/>
            </div>

            <div>
              <div style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600, marginBottom: 6 }}>
                รายการ ({(editing.items || []).length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(editing.items || []).map((row, i) => {
                  const item = items.find(x => x.id === row.itemId)
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <select value={row.itemId}
                        onChange={e => {
                          const it = items.find(x => x.id === e.target.value)
                          updateItemRow(i, { itemId: e.target.value, unitUse: it?.unitUse || '' })
                        }}
                        style={{ flex: 1, padding: '6px 8px', borderRadius: 8,
                          border: '1.5px solid var(--border2)', fontSize: 12 }}>
                        <option value="">-- เลือก --</option>
                        {sortByMaster(items).map(it => <option key={it.id} value={it.id}>{it.img} {it.name}</option>)}
                      </select>
                      <input type="number" value={row.qty}
                        onChange={e => updateItemRow(i, { qty: e.target.value })}
                        min="0" step="any"
                        style={{ width: 60, padding: '6px 8px', borderRadius: 8,
                          border: '1.5px solid var(--border2)', fontSize: 12, textAlign: 'right' }}/>
                      <span style={{ fontSize: 11, color: 'var(--txt3)', minWidth: 40 }}>
                        {item?.unitUse || row.unitUse}
                      </span>
                      <button onClick={() => removeItemRow(i)}
                        style={{ padding: '4px 8px', borderRadius: 6, border: 'none',
                          background: '#FEE2E2', color: '#DC2626', fontSize: 12, cursor: 'pointer' }}>×</button>
                    </div>
                  )
                })}
              </div>
              <button onClick={addItemRow}
                style={{ marginTop: 8, padding: '6px 12px', borderRadius: 8,
                  border: '1.5px dashed var(--border2)', background: 'transparent',
                  color: 'var(--txt2)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                + เพิ่มรายการ
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setEditing(null)} disabled={loading}
                style={{ flex: 1, padding: '10px 16px', border: '1.5px solid var(--border2)',
                  borderRadius: 10, background: '#fff', color: 'var(--txt2)',
                  fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>ยกเลิก</button>
              <button onClick={handleSave} disabled={loading}
                style={{ flex: 2, padding: '10px 16px', border: 'none', borderRadius: 10,
                  background: loading ? 'var(--border2)' : 'var(--red)', color: '#fff',
                  fontSize: 13, fontWeight: 700, cursor: loading ? 'wait' : 'pointer' }}>
                {loading ? 'กำลังบันทึก...' : '✓ บันทึก'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
