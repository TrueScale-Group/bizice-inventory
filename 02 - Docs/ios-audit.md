# 🍎 iOS Audit — BizICE Inventory (ตรวจ 15 มิ.ย. 2569)

> ตรวจโดย agent 4 ตัว (input/picker · touch/gesture · CSS/layout · PWA/API) แล้วกรองเอาเฉพาะที่ **ยืนยันกับโค้ดจริง**
> `viewport-fit=cover` ✅ มีใน index.html แล้ว · safe-area inset ใช้บางจุด

---

## ✅ แก้แล้ว
| # | ปัญหา | เวอร์ชัน |
|---|-------|---------|
| 1 | ปุ่มกากบาท `✕` (U+2715) มองไม่เห็นบน iOS (ฟอนต์ Sarabun/Prompt ไม่มี glyph) → เปลี่ยนเป็น `×` + font ระบบ | v2.8.2 |
| 2 | ปุ่มเลือกวันที่ (📅 หน้ารายงาน) กดไม่ได้บน iPhone — เดิม `showPicker()`/`.click()` ไป input ที่ซ่อน iOS บล็อก → วาง input โปร่งใสทับปุ่มตรง ๆ | v2.8.3 |
| A | Export/Download เงียบบน iOS standalone → สร้าง `utils/download.js` (`saveOrShareFile`) ตรวจ standalone → `navigator.share()`, ไม่ revoke ทันที (delay 4s) · refactor SeedStock/Settings(CSV)/DataSheet(XLSX) · **wire ปุ่ม Export หน้ารายงาน** ให้ export cutlog CSV | v2.9.0 |
| B | Input ซูม + คีย์บอร์ดผิด → `.fi` 14→16px + global `input/select/textarea {16px !important}` กันซูม · `inputMode="decimal"` 4 จุด (Adjust/MinStock/CutStock/Warehouse) | v2.9.0 |
| C | Tooltip ⓘ Settings เปิดด้วย `:hover` → เพิ่ม `.tip-open` toggle ด้วย onClick (iOS แตะติด) | v2.9.0 |
| 🟡 | safe-area: `.toast` +inset-top · `.notif-panel` +inset-right · `.modal-backdrop` insets ครบ 4 ด้าน (notch แนวนอน) | v2.9.0 |

### ✅ งาน impact ต่ำ — ทำครบแล้ว (v2.9.1)
- **autoFocus modal** — iOS บล็อกเปิดคีย์บอร์ดอัตโนมัติ (ไม่มี gesture) บังคับไม่ได้จริง → คง autoFocus ไว้ (Android/desktop) + เพิ่ม `onFocus scrollIntoView` ให้ช่องเลื่อนขึ้นเหนือคีย์บอร์ดเมื่อแตะ (Dashboard PO reason, Settings inline edit)
- **apple-touch-icon** — สร้าง 180/167/152px จากต้นฉบับ 2048px (เบากว่า + คมกว่า) + ใส่ `<link sizes>` ใน index.html
- **session ITP** — ขยาย TTL 24 ชม. → **30 วัน แบบ sliding** (ต่ออายุทุกครั้งที่เปิด) ใน index.html — active use กัน ITP 7 วันได้

---

## 🔴 จริง — ควรแก้

### A. Export / Download เงียบบน iOS standalone PWA
- `src/components/SeedStockModal.jsx:204` `downloadFile()` — ใช้ `<a download>.click()` + `revokeObjectURL` ทันที
- `src/pages/Settings.jsx:~3743` export, `src/components/DataSheetModal.jsx:~162` เช่นเดียวกัน
- `src/pages/Report.jsx:2690` ปุ่ม **"📤 Export" ยังไม่มี `onClick`** (ไม่ทำงานทุกแพลตฟอร์ม)
- **iOS standalone (เพิ่มหน้าจอโฮม) ไม่รองรับ `<a download>`** → กดแล้วเงียบ ไฟล์ไม่ออก
- **แก้:** ตรวจ `navigator.standalone` → fallback `navigator.share()` / เปิด data URI ในแท็บใหม่ / ก็อปข้อความ + wire ปุ่ม Export หน้ารายงานให้ทำงาน

### B. Input ตัวเลข — zoom + คีย์บอร์ดผิด
- `.fi` (index.css:768) font-size **14px** + date input หลายตัว 12–12.5px → **iOS auto-zoom เมื่อโฟกัส** (ต้อง ≥16px ถึงไม่ซูม)
- number input หลายตัวไม่มี `inputMode` → คีย์บอร์ด iOS ไม่ขึ้นจุดทศนิยม: `AdjustStockModal.jsx:197`, `MinStockEditModal.jsx:76`, `CutStock.jsx:487`, `Warehouse.jsx:1010`
- **แก้:** input font-size 16px (กันซูม) + `inputMode="decimal"` (จำนวนทศนิยม) / `"numeric"` (จำนวนเต็ม)

### C. Tooltip ⓘ ใน Settings เปิดด้วย :hover/:focus
- `index.css:855` `.setting-info:hover .setting-tip` — iOS ไม่มี hover → แตะไม่ติด tooltip ไม่ขึ้น
- **แก้:** เปลี่ยนเป็น onClick toggle state

---

## 🟡 รอง / ขัดใจเล็กน้อย
- `.toast` (index.css:751) `top:64px` ไม่บวก `env(safe-area-inset-top)` → โดน notch บัง (แนวนอน/บางรุ่น)
- `.notif-panel` (index.css:1213) ใช้ `100vw` + ไม่มี safe-area-inset-right → ถูก notch บังตอนแนวนอน
- `.modal-backdrop` padding safe-area เฉพาะล่าง — ขาดซ้าย/ขวา (notch แนวนอน)
- `autoFocus` ใน modal (`Dashboard.jsx:2986`, `Settings.jsx:522`) — iOS ไม่เปิดคีย์บอร์ดถ้าไม่ใช่ user gesture
- `apple-touch-icon` ใช้ 512×512 ตัวเดียว — iOS อยากได้ 180×180 (ไอคอนโฮมคมขึ้น)
- localStorage session 24 ชม. — iOS ITP ลบ storage หลังไม่ใช้ 7 วัน (session มาจาก Hub URL อยู่แล้ว ผลกระทบจำกัด)

---

## ❌ agent flag แต่ตรวจแล้ว "ไม่ใช่บั๊กจริง"
- **Date parsing `new Date(key+'T00:00:00')`** — `toDateKey()` pad เลข 0 เสมอ → key เป็น `YYYY-MM-DD` ตลอด → valid บน iOS ✓ (เสี่ยงเฉพาะถ้ามี data วันที่ไม่ pad)
- **preventDefault บน backdrop บล็อก tap ปุ่มข้างใน** — กล่องในมี `stopPropagation` แล้ว handler backdrop ไม่ยิงตอนแตะข้างใน → ใช้งานได้จริง
- **hoverItem reveal ใน Warehouse** — เป็น `onClick` toggle (ไม่ใช่ `:hover`) → iOS แตะได้ปกติ
- **AudioContext ต้อง user gesture** — beep ถูกเรียกจาก onClick (เป็น gesture) + ครอบ try/catch → ไม่พัง
