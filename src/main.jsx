import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ssoBootstrap } from './ssoBootstrap'

// รอ SSO bootstrap (signInWithCustomToken จาก Hub) ให้เสร็จก่อน render
//   claims === null = ไม่มี auth → ssoBootstrap เด้งกลับ Hub แล้ว ไม่ต้อง render
ssoBootstrap()
  .then(claims => {
    if (claims === null) return
    mount()
  })
  .catch(() => mount())   // auth พัง → ยัง render (session params เดิมยังอ่านได้)

function mount() {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
