export function useSession() {
  const s = window._bizSession || {}
  const bizMode = window._bizMode || ''
  return {
    session: s,
    isEditor: () => {
      if (!s) return false
      if (s.role === 'owner' || s.role === 'admin') return true
      // Hub passes ?mode=editor|viewer via URL — takes priority over stale localStorage
      if (bizMode === 'viewer') return false
      if (bizMode === 'editor' || bizMode === 'owner') return true
      return s.apps?.['inventory'] === 'editor'
    },
    // owner-level = เจ้าของ หรือ แอดมิน (อำนาจเท่ากัน)
    isOwner:  () => s?.role === 'owner' || s?.role === 'admin',
    isViewer: () => {
      if (s?.role === 'owner' || s?.role === 'admin') return false
      if (bizMode === 'viewer') return true
      if (bizMode === 'editor' || bizMode === 'owner') return false
      return s?.role === 'viewer' || !s?.apps?.['inventory']
    },
    name: s.name || '',
    phone: s.phone || '',
    role: s.role || 'viewer',
    branch_id: s.branch_id || '',
    isStaff: () => s?.role === 'staff',
    // รูปโปรไฟล์จาก Hub: s.photo → bizice_avatar_<phone> (same-origin) → null
    photo: s.photo || (s.phone ? (() => { try { return localStorage.getItem('bizice_avatar_' + s.phone) } catch { return null } })() : null) || '',
    initials: (s.name || '?').replace(/^(พี่|น้อง|คุณ)/, '').trim().charAt(0) || '?',
  }
}
