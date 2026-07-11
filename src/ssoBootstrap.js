// SSO bootstrap — รับ custom token จาก Hub (bizice.web.app) ผ่าน URL fragment #t=<token>
//   งานหลัก = ทำให้แอพมี request.auth (signInWithCustomToken) รองรับ Firestore role-based rules
//   ★ ไม่รื้อ logic session เดิม (index.html อ่าน ?mode/user/phone/branch อยู่แล้ว) — ทำงานคู่กัน
//   flow: Hub navigate เต็มหน้ามาที่ /?user=..&phone=..&mode=..#t=<CUSTOM_TOKEN>
import { signInWithCustomToken, onAuthStateChanged } from 'firebase/auth'
import { auth } from './firebase'

const HUB_URL = '/'   // origin-relative: Hub = root ของ origin เดียวกัน (single-origin)

/**
 * เรียก "ก่อน" render แอพหลัก (ใน main.jsx)
 * @returns claims {role, branch_id, apps, phone} · หรือ null ถ้าไม่มี auth (กำลังเด้งกลับ Hub)
 */
export async function ssoBootstrap() {
  const m = location.hash.match(/[#&]t=([^&]+)/)
  const token = m ? decodeURIComponent(m[1]) : null
  if (token) {
    try {
      await signInWithCustomToken(auth, token)
    } catch (e) {
      console.error('[SSO] signInWithCustomToken failed:', e)
    }
    // ★ ล้าง token ทิ้งจาก URL เสมอ (กัน token ค้างใน address bar / history)
    history.replaceState(null, '', location.pathname + location.search)
  }

  // รอ auth state ครั้งแรก — persisted user (เข้าซ้ำ) หรือ user ที่เพิ่ง sign-in
  const user = await new Promise(res => {
    const off = onAuthStateChanged(auth, u => { off(); res(u) })
  })

  // 🧪 localhost dev bypass — เข้าทดสอบได้โดยไม่ต้อง auth/ผ่าน Hub
  //    เช็ค hostname ตรงๆ (ไม่ใช้ env var) → production (github.io / .web.app) เข้าเงื่อนไขนี้ไม่ได้เด็ดขาด
  const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1'

  // ไม่มี user = ไม่ได้เข้าทาง Hub (หรือ token หมดอายุ) → เด้งกลับ Hub ให้ mint ใหม่
  if (!user) {
    if (isLocalDev) {
      // localhost = ให้ render แอพต่อ (ไม่มี request.auth จริง — Firestore rules ที่บังคับ auth จะ fail ตามคาด)
      console.warn('[SSO] localhost dev — ข้าม auth, ไม่มี request.auth')
      return {}
    }
    location.href = HUB_URL
    return null
  }

  try {
    const { claims } = await user.getIdTokenResult()
    return claims   // {role, branch_id, apps, phone}
  } catch {
    return {}       // auth มีจริงแล้ว แค่ decode claims พลาด → ยังให้เข้าแอพได้
  }
}
