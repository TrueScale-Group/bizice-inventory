import { useEffect, useRef, useState } from 'react'

/**
 * Modal (Bottom Sheet)
 *
 * Props:
 *   open       — boolean
 *   onClose    — fn
 *   title      — string
 *   lockClose  — boolean  เมื่อ true: กด backdrop/X ครั้งแรก → แสดง confirm bar
 *                          กด backdrop/X ขณะ bar แสดง → shake bar + bounce X (ไม่ปิด)
 *                          กด "ออก" ใน bar เท่านั้น → ปิด
 *   children
 *   footer
 */
export function Modal({ open, onClose, title, children, footer, lockClose = false }) {
  const [xBounce,     setXBounce]     = useState(false)
  const [confirmExit, setConfirmExit] = useState(false)
  const [barShake,    setBarShake]    = useState(false)
  const xBtnRef = useRef(null)

  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  useEffect(() => { if (!open) { setConfirmExit(false); setBarShake(false) } }, [open])

  if (!open) return null

  function shake() {
    setXBounce(true)
    setBarShake(false)
    // double-rAF to restart animation even if already animating
    requestAnimationFrame(() => requestAnimationFrame(() => setBarShake(true)))
  }

  function handleBackdrop(e) {
    if (e.target !== e.currentTarget) return
    if (!lockClose) { onClose(); return }
    if (confirmExit) { shake(); return }   // bar แสดงอยู่ → shake ห้ามออก
    setConfirmExit(true)
    setXBounce(true)
  }

  function handleX() {
    if (!lockClose) { onClose(); return }
    if (confirmExit) { shake(); return }   // bar แสดงอยู่ → shake ห้ามออก
    setConfirmExit(true)
    setXBounce(true)
  }

  return (
    <div className="modal-backdrop" onClick={handleBackdrop}>
      <div className="bottom-sheet">
        <div className="sheet-handle" />
        <div className="sheet-header">
          <span className="sheet-title">{title}</span>
          <button
            ref={xBtnRef}
            className="sheet-close"
            onClick={handleX}
            style={xBounce ? { animation: 'xBounce 0.45s ease' } : {}}
            onAnimationEnd={() => setXBounce(false)}
          >
            ✕
          </button>
        </div>

        {/* Confirm-exit bar */}
        {confirmExit && (
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: '#FFF7ED', borderBottom: '1px solid #FED7AA',
              padding: '8px 16px', gap: 10, flexShrink: 0,
              animation: barShake ? 'guardBarShake 0.4s ease' : 'none',
            }}
            onAnimationEnd={() => setBarShake(false)}
          >
            <span style={{ fontSize: 13, color: '#92400E', fontWeight: 600 }}>
              ⚠️ ออกโดยไม่บันทึก?
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setConfirmExit(false)}
                style={{ padding: '4px 14px', borderRadius: 8, border: '1.5px solid #D97706',
                  background: '#fff', color: '#D97706', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                ยกเลิก
              </button>
              <button
                onClick={onClose}
                style={{ padding: '4px 14px', borderRadius: 8, border: 'none',
                  background: '#EF4444', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                ออก
              </button>
            </div>
          </div>
        )}

        <div className="sheet-body">{children}</div>
        {footer && (
          <div style={{ padding: '0 16px 16px', flexShrink: 0 }}>{footer}</div>
        )}
      </div>
    </div>
  )
}
