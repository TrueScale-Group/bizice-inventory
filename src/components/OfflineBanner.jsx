import { useOnline } from '../hooks/useOnline'

/**
 * OfflineBanner — แสดงเตือนเมื่ออยู่ในโหมดออฟไลน์
 * ใช้ข้อมูลแคช Firestore (offline persistence) จึงดูทุกอย่างได้
 * แต่ปิดปุ่มเขียน (ตัด/ปรับ/โอน) เพื่อป้องกัน conflict
 */
export function OfflineBanner() {
  const online = useOnline()
  if (online) return null
  return (
    <div style={{
      background: 'linear-gradient(135deg,#F59E0B,#D97706)',
      color: '#fff',
      padding: '8px 14px',
      fontSize: 12,
      fontWeight: 700,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      borderBottom: '1px solid rgba(0,0,0,.1)',
      boxShadow: '0 2px 8px rgba(217,119,6,.25)',
      position: 'sticky',
      top: 0,
      zIndex: 100,
      animation: 'offlineSlideDown .3s ease',
    }}>
      <style>{`
        @keyframes offlineSlideDown {
          from { transform: translateY(-100%); opacity: 0; }
          to   { transform: translateY(0); opacity: 1; }
        }
        @keyframes offlineDot {
          0%,100% { opacity: 1; }
          50%     { opacity: .4; }
        }
      `}</style>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', background: '#fff',
        animation: 'offlineDot 1.2s ease-in-out infinite',
      }} />
      <span style={{ flex: 1 }}>
        📡 โหมดออฟไลน์ — ดูข้อมูลล่าสุดที่แคชไว้ได้ แต่จะบันทึก/แก้ไขไม่ได้จนกว่าจะออนไลน์
      </span>
    </div>
  )
}
