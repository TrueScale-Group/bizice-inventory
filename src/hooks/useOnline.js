import { useState, useEffect } from 'react'

/**
 * useOnline — ติดตามสถานะเครือข่าย (online / offline)
 * ใช้ navigator.onLine + window events
 * ดู: https://developer.mozilla.org/docs/Web/API/Navigator/onLine
 */
export function useOnline() {
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )
  useEffect(() => {
    const on  = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}
