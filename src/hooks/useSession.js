export function useSession() {
  const s = window._bizSession || {}
  return {
    session: s,
    isEditor: () => {
      if (!s) return false
      if (s.role === 'owner') return true
      return s.apps?.['inventory'] === 'editor'
    },
    isOwner: () => s?.role === 'owner',
    name: s.name || '',
    phone: s.phone || '',
    role: s.role || 'viewer',
  }
}
