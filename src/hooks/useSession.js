export function useSession() {
  const s = window._bizSession || {}
  const bizMode = window._bizMode || ''
  return {
    session: s,
    isEditor: () => {
      if (!s) return false
      if (s.role === 'owner') return true
      // Hub passes ?mode=editor|viewer via URL — takes priority over stale localStorage
      if (bizMode === 'viewer') return false
      if (bizMode === 'editor' || bizMode === 'owner') return true
      return s.apps?.['inventory'] === 'editor'
    },
    isOwner: () => s?.role === 'owner',
    name: s.name || '',
    phone: s.phone || '',
    role: s.role || 'viewer',
  }
}
