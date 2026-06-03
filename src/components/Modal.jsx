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
  const [xBounce, setXBounce] = useState(false)

  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  function blockEvent(e) {
    // ป้องกัน backdrop ปิด modal + bounce ✕ เรียกความสนใจ
    e.stopPropagation()
    e.preventDefault()
    setXBounce(false)
    requestAnimationFrame(() => requestAnimationFrame(() => setXBounce(true)))
  }

  return (
    <div
      className="modal-backdrop"
      onClick={blockEvent}
      onTouchStart={blockEvent}
      onTouchEnd={blockEvent}
      onPointerDown={blockEvent}
    >
      <div className="bottom-sheet"
        onClick={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
        onPointerDown={e => e.stopPropagation()}>

        <div className="sheet-handle" />
        <div className="sheet-header">
          <span className="sheet-title">{title}</span>
          <button
            className="sheet-close popup-x-btn"
            onClick={onClose}
            onAnimationEnd={() => setXBounce(false)}
            style={{ animation: xBounce ? 'xBounce 0.45s ease' : 'none' }}
          >
            ✕
          </button>
        </div>

        <div className="sheet-body">{children}</div>
        {footer && (
          <div style={{ padding: '0 16px 16px', flexShrink: 0 }}>{footer}</div>
        )}
      </div>
    </div>
  )
}
