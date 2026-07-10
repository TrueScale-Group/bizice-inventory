# Inventory V3 — Design + UX Roadmap

> Audit จาก v2.0.41 · พื้นฐาน: real-world Mixue store usage
> อัปเดต: 4 มิ.ย. 2569

---

## ✅ V2 ที่ทำเสร็จแล้ว (ห้ามแตะ)

- 🔔 Push notification (FCM → Hub bell branded)
- 👓 ItemHistoryPopup + running balance + scope per warehouse
- 🍦 PWA + Service Worker + Firestore persistent cache
- 📛 App icon badge + status bar icon (ไอติม monochrome)
- ⚖️ Smart unit display (prefer integer unit input ของ user)
- 🎨 Master data alertEnabled toggle + lock Min/Max
- 📊 Analyze tab (KPI + bar tooltip + custom date range + dual top 5)
- 🚚 Transfer dispatch/receive/cancel push events
- 🔍 Search bar iOS pill ใน Warehouse + CutStock
- 🎯 Daily log popups (waste, receive, refill, cut summary)

→ ระบบ stable production-grade ครบ ไม่ refactor ใหญ่

---

## 🔴 Priority 1 — Quick Wins (max ROI)

### 1. CutStock swipe gestures
**ลด tap 50+ ต่อวัน · staff หลายคน**
- **Swipe left** บน POS card → ตัด -1 ทันที
- **Long-press** → custom qty
- เพิ่ม "Recently used" auto-sort ใต้ "ของฉัน"
- Reference: `react-swipeable` หรือ native touchstart/touchend

### 2. Undo snackbar
**แก้ "กลัวกดผิด" anxiety**
- หลัง confirm cut → toast "ตัดสำเร็จ · ↶ ย้อนกลับ" 5 วินาที
- กดแล้ว → cancel cut log + restore stock
- ใช้ pattern เดียวกับ Gmail "Undo send"

### 3. Trend arrows ทุก KPI
**Owner เห็น insight ทันที**
- เพิ่ม "▲ +12% vs เมื่อวาน" ใต้ทุก KPI
- คำนวณจาก `dailyCostMap` / `dailyRevMap` ที่มีอยู่แล้ว
- Sparkline เล็กๆ ใต้ตัวเลข (optional)

### 4. Merge Bell + KPI cards + Hub badge
**ลด confusion (4 แห่งแสดงข้อมูลเดียวกัน)**
- Bell ใน topbar = source of truth
- KPI "ใกล้หมด/หมดแล้ว" → เปลี่ยนเป็น **action card** "แจ้งเติม X รายการ →"
- Hub home preview ของ Bell

---

## 🟡 Priority 2 — UX Improvements

### 5. Date scope sync ใน Report
- Report level state — ทุก sub-tab (Daily log / Waste / Analyze) ใช้ date เดียวกัน
- ตอนนี้แต่ละ tab มี state แยก → switch tab reset

### 6. Empty states ให้ช่วยเหลือ
ทุก `<EmptyState>` ต้องมี:
- emoji ใหญ่
- อธิบายสั้นๆ
- ปุ่ม CTA ให้ทำต่อ
```
🍓
ยังไม่มีของเสียวันนี้
[+ บันทึกของเสีย]
```

### 7. Filter chips ใต้ search
- เพิ่ม filter pills: "ใกล้หมด" / "หมดอายุเร็ว" / "ราคาสูง" / "ปรับล่าสุด"
- ใช้กับ Warehouse + CutStock + History

### 8. Bulk operations
- Multi-select mode (long-press chip → checkbox)
- Bulk actions: Update minQty, Toggle alert, Export selected
- เริ่มจาก Master Data (Settings)

### 9. Long Thai names — tooltip + 2-line
- `whiteSpace: normal` + max 2 lines + ellipsis
- Hover/long-press → tooltip แสดง full name
- ใช้ displayName ทุกที่ (มีอยู่ ตรวจซ้ำ)

### 10. Visual hierarchy — color palette restricted
- Primary action color: **var(--red)** เท่านั้น
- KPI status: success/warning/danger/neutral 4 สี
- Data viz: palette แยก
- ลบสีที่ใช้แค่ 1-2 ที่ออก

---

## 🟢 Priority 3 — Polish

### 11. Skeleton screens แทน spinner
- POS card loading → skeleton 8 cards
- Report KPI loading → skeleton bars
- Reference Pattern: framer-motion + animated div

### 12. Haptic feedback
- Vibrate บน mobile เมื่อ:
  - Cut confirm: 50ms
  - Cancel: 100ms x 2
  - Error: 200ms
- API: `navigator.vibrate()`

### 13. Sound feedback toggle
- มี `src/utils/audio.js` แล้ว
- Settings → toggle "เปิดเสียง" — เก็บใน localStorage
- ทดสอบครบทุก beep* function ที่มีอยู่

### 14. Dark mode
- Toggle ใน Settings
- Auto-detect `prefers-color-scheme: dark`
- ใช้ CSS variables (มีอยู่แล้ว) — เปลี่ยน root values

### 15. First-open tour
- 5-step highlight features (Dashboard / Warehouse / CutStock / Report / Settings)
- localStorage flag: `bizice_inv_tour_done`
- Library: ใช้ basic CSS overlay ก็พอ ไม่ต้อง driver.js

### 16. Audit trail UI inline
- ทุก data row → ปุ่ม "ใครแก้?"
- Popup mini history (ใช้ stock_movements + audit_logs)
- Reference: pattern ItemHistoryPopup แต่ scope narrower

---

## 💡 Long-term Vision (V4+)

- 🤖 **AI suggestion** — auto-reorder based on usage pattern
- 📸 **Photo receipt OCR** — รับสินค้าจากใบเสร็จ supplier
- 🎤 **Voice cut stock** — "ส้ม 5 ลูก" → ตัด
- 🏪 **Multi-branch** — Mixue ขยายสาขา 2, 3
- 💰 **Cost optimization suggestion** — "เปลี่ยน supplier X → ประหยัด ฿2K/เดือน"

---

## 📋 Best Practices สำหรับ V3

### ✅ DO
- Reuse existing patterns (Modal, Toast, popup-x-btn)
- ใช้ displayName + emoji ทุก UI
- Test กับ tablet + PC + mobile ทุก feature
- bump version ทุก deploy (`package.json` + Settings v-tag)
- Commit per feature

### ❌ DON'T
- อย่าแตะ `firebase.js` (Firestore persistent cache)
- อย่าแก้ `NotifBell.jsx` (live computed + skip alertEnabled)
- อย่า bypass `Modal` component (use shared shell)
- อย่า refactor ItemHistoryPopup running balance logic
- อย่าใส่ `display: none` กับ `<DailyTab>` (state เพี้ยน)

---

## 🔗 Reference paths

- Push: `src/firebase.js` → `sendHubPush(notifId)`
- History popup: `src/pages/Warehouse.jsx` → `ItemHistoryPopup`
- Cut logic: `src/utils/cutStock.js`
- Adjust logic: `src/utils/adjustStock.js`
- Unit smart display: `src/utils/unit.js`
- Constants: `src/constants/collections.js`

### Schema
- `stock_balances` doc id: `${warehouseId}_${itemId}` (deterministic)
- `stock_movements`: qty (in unitBase) + qtyUse (in unitUse) signed
- `items.alertEnabled: boolean` (default true)
- `items.unitConversion: '1 ลัง = 20 กระป๋อง'`

---

## 🚀 Deploy

```bash
npm run deploy   # build + gh-pages auto
```
Repo: `truescale-group/bizice-inventory`

---

## 📌 Commit style
- `feat(inv): ...`
- `fix(inv): ...`
- `style(inv): ...`
- `refactor(inv): ...`

---

ถ้าจะเริ่มทำ V3 → แนะนำ **เริ่มจาก #1 + #2** (swipe + undo)
ใช้เวลา ~4-6 ชม. ครับ ROI สูงสุด 🌸
