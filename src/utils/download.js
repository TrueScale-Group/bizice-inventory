// download.js — บันทึก/แชร์ไฟล์ ให้รองรับ iOS standalone PWA ด้วย
// (iOS เพิ่มหน้าจอหลัก → <a download>.click() เงียบ ๆ ล้มเหลว → ใช้ Web Share แทน)

export async function saveOrShareFile(filename, data, mime = 'text/csv;charset=utf-8;') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime })
  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia?.('(display-mode: standalone)')?.matches === true
  // iOS standalone: <a download> ใช้ไม่ได้ → ลอง Web Share (แชร์ไป Files/Messages/etc.)
  try {
    if (isStandalone && typeof File !== 'undefined' && navigator.canShare) {
      const file = new File([blob], filename, { type: mime })
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename })
        return 'shared'
      }
    }
  } catch (e) { /* user cancel หรือ share fail → ตกไปวิธีปกติ */ }
  // วิธีปกติ (desktop / Android / iOS Safari แท็บปกติ)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.rel = 'noopener'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)  // อย่า revoke ทันที — iOS/บาง browser จะตัดดาวน์โหลด
  return 'downloaded'
}
