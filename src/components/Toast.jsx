import { useEffect, useState } from 'react'

export function Toast({ message, onDone }) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => {
      setVisible(false)
      setTimeout(onDone, 300)
    }, 3000)
    return () => clearTimeout(t)
  }, [onDone])

  if (!visible) return null
  return <div className="toast">{message}</div>
}
