# iOS Bug — ปุ่มกากบาท (✕) หายใน Popup

## ปัญหา
ใน iPhone (iOS Safari PWA) ปุ่ม ✕ สำหรับปิด popup / modal มองไม่เห็น

## สิ่งที่ต้องตรวจสอบ
1. ปุ่ม ✕ อยู่ใน element ที่มี `overflow: hidden` → ถูก clip ออก
2. ปุ่ม ✕ อยู่ใน `position: absolute` แต่ parent ไม่ได้ `position: relative`
3. `z-index` ของปุ่มต่ำกว่า overlay → ถูกทับ
4. `env(safe-area-inset-top)` ไม่ถูก apply → ปุ่มซ่อนอยู่หลัง notch / status bar

## วิธีแก้ที่แนะนำ
- ตรวจ CSS ของ modal header / close button
- เพิ่ม `padding-top: env(safe-area-inset-top)` ที่ topbar ของ popup ถ้ายังไม่มี
- ให้ปุ่ม ✕ เป็น `<button>` ไม่ใช่ `<span>` หรือ `<div>`
- ตรวจ `z-index` ให้สูงกว่า overlay

## หมายเหตุ
- พบจาก iPhone น้องอีฟ (iOS Safari standalone PWA)
- Android ปกติ ไม่มีปัญหา
- ผู้รายงาน: เจ้าของร้าน (ทดสอบ 14 มิ.ย. 2569)

---

## ✅ สรุปสาเหตุจริง + วิธีแก้ (แก้แล้ว v2.8.2 · 15 มิ.ย. 2569)

**สาเหตุจริง = glyph ฟอนต์ (ไม่ใช่ overflow/safe-area/z-index ตามที่เดาไว้ข้างบน):**
- ปุ่มปิดเดิมใช้อักขระ **`✕` (U+2715, dingbat)** + inherit ฟอนต์ **Sarabun/Prompt**
- Sarabun/Prompt เป็นฟอนต์ไทย+ละติน **ไม่มี glyph ตัว `✕`**
- **Android Chrome**: fallback ไปฟอนต์ระบบ (Noto/Roboto) อัตโนมัติ → เห็นปกติ
- **iOS Safari (standalone PWA)**: fallback ไม่ทำงาน (webfont map ตัวนี้เป็น glyph ว่าง) → ปุ่มว่างเปล่า มองไม่เห็น
- ทำไม "overflow/safe-area" ตัดทิ้งได้: ถ้าใช่ Android ต้องเป็นด้วย แต่ Android ปกติ → ชี้ชัดว่าเป็นเรื่อง glyph เฉพาะแพลตฟอร์ม

**สิ่งที่แก้:**
1. เปลี่ยนอักขระ `✕` (U+2715) → **`×` (U+00D7 ตัวคูณ)** ทั้งแอพ (29 จุด/6 ไฟล์) — `×` อยู่ใน Latin-1 ที่ Sarabun/Prompt มี glyph จริงทุกแพลตฟอร์ม
2. CSS `.sheet-close, .popup-x-btn` เพิ่ม hardening: `font-family: -apple-system, system-ui, 'Segoe UI Symbol', sans-serif` (บังคับฟอนต์ระบบที่มี glyph) + `-webkit-appearance: none` + `line-height: 1` + `-webkit-text-fill-color`
3. bump `sw.js` CACHE_VERSION → `v2.0.37` (ไม่งั้น iOS PWA เสิร์ฟ CSS เก่าจาก cache)

> ⚠️ มาตรฐานต่อไป: **ห้ามใช้ `✕` (U+2715) เป็นไอคอนปุ่ม — ใช้ `×` (U+00D7) แทน** เพราะ dingbat ส่วนใหญ่ไม่มีในฟอนต์ไทย (ดู `01 - APP/function-back.md`)
