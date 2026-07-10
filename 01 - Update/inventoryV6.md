# inventoryV6.md
# 📦 งานค้าง / Backlog — Inventory System (BizICE APP)
> **Project:** BizICE APP | Firebase Project: `mixue-cost-manager`
> **วันที่รวบรวม:** 8 กรกฎาคม 2026
> **เวอร์ชันปัจจุบัน (live):** v5.7.0
> **ขอบเขต:** เฉพาะมินิแอป Inventory เท่านั้น (frontend React ที่ `01 - APP/03 - Inventory`) — ไม่รวม Hub / Cost Manager / Daily Income และ **ไม่รวม backend ที่ `00 - Functions`**

---

## 🎯 บริบท

รวบรวมงานที่ยัง "ค้าง" ของ Inventory หลังจบรอบ LOT overhaul ครั้งใหญ่ (v5.5.0 → v5.7.0: family LOT view, เครื่องมือ Reconcile, toggle ปิด LOT, fix staff เห็นคลังกลาง)

> **หมายเหตุ stack:** Inventory เป็น React 18 + Vite + Tailwind (ยัง**ไม่ใช่** React 19 — เคยเข้าใจผิด ตรวจ package.json จริงแล้วเป็น `^18.3.1`) · งาน "Stack Migration Vanilla→React" ไม่เกี่ยวกับ Inventory (เป็นของ Hub/Cost Manager/Daily Income)

**สารบัญงาน:**
- **A.** รอเจ้าของกดในแอป (ไม่ใช่โค้ด)
- **B.** งานโค้ด: B1 React 19 · B2 Branch Awareness · B3 Code Cleanup · B4 guard หน่วยเพี้ยน · B5 read opt
- **C.** เอกสาร (README สถาปัตยกรรม + changelog)
- **D.** ขอบเขตที่ **ไม่ใช่** ของ Inventory (อยู่ที่ `00 - Functions`)
- **E.** Infra ร่วม (Security Rules)

---

## A. งานที่รอเจ้าของกดในแอป (User Action)

### A1 — กด Reconcile LOT 🟠
เครื่องมือพร้อมที่ **ตั้งค่า → เครื่องมือข้อมูล → 🧩 ปรับ LOT ให้ตรงสต็อก** (v5.6.x) แต่ยังไม่ได้กดซ่อมจริง
- [ ] สแกน → "ซ่อมทั้งหมด" (~101 รายการ / 6 orphan ระบบข้ามให้) → สแกนซ้ำยืนยันเหลือ 0
- **ผลลัพธ์:** ยอด LOT ตรงยอดจริงทุกป๊อปอัพ · แถบเตือน ⚠️ drift หาย · **ยอดคงเหลือจริงไม่ถูกแตะ**

### A2 — จัดการ LOT ที่ค้างข้อมูล EXP 🟡
- [ ] เติม EXP ผ่านปุ่ม 📋 "ใช้ EXP จาก LOT คลังกลาง" (v5.6.2) หรือปิด LOT รายตัว (toggle 📦 ใน Master Data, v5.7.0)

---

## B. งานโค้ด

### โจทย์ B1 — อัพเดต React 18.3.1 → 19.2.7 🔴 (พร้อมทำ)

**ปัญหา:** Inventory ยังเป็น React `^18.3.1` ขณะที่ Insight อัพเป็น `^19.2.0` (ติดตั้งจริง 19.2.7) แล้ว — ทำให้ทั้ง 6 แอปยังไม่ consistent (โจทย์นี้คือ "dependency upgrade" ไม่ใช่ framework rewrite)

**ผลตรวจโค้ด (8 ก.ค.):** โค้ด **สะอาดมาก ไม่มี breaking pattern ของ React 19 เลย**
- ❌ ไม่มี `defaultProps` บน function component · ❌ ไม่มี `propTypes` · ❌ ไม่มี string ref · ❌ ไม่มี `forwardRef` · ❌ ไม่มี `findDOMNode`/`ReactDOM.render` · ❌ ไม่มี legacy context
- ✅ `main.jsx` ใช้ `createRoot` อยู่แล้ว · ✅ ใช้แค่ `React.StrictMode` (OK กับ 19) · ✅ deps อื่น (firebase, xlsx-js-style) ไม่มี React peer

**สิ่งที่ต้องทำ (แก้ 4 บรรทัดใน package.json ให้ตรง Insight):**
- [ ] `react`, `react-dom` → `^19.2.0`
- [ ] `@types/react`, `@types/react-dom` → `^19.2.0`
- [ ] คง `@vitejs/plugin-react ^4.3.1` + `vite ^5.3.1` (เหมือน Insight ที่ผ่านแล้ว)
- [ ] `npm install` → `npm run build` → ทดสอบ localhost ทุกแท็บ → **ขอ deploy ก่อน push**

**Acceptance:** build ผ่าน · ทุกแท็บทำงานปกติใน localhost · badge เวอร์ชันเด้ง · React runtime = 19.2.x

---

### โจทย์ B2 — Branch Awareness (ความเข้าใจสาขาให้สม่ำเสมอ) 🟠

**ปัญหา:** logic การ scope ตามสาขา/role กระจายหลายที่และเคยมีบั๊กจริง (staff เห็นคลังกลาง = 0 เพราะ `warehouses` ถูก filter เหลือสาขาเดียว → `warehouses.find(main)` = undefined) แก้ไป 4 จุดแล้ว (ผ่าน `mainWarehouse` prop) แต่ยังไม่ครบและยังไม่มีมาตรฐานกลาง

**จุดที่ logic branch กระจายอยู่:** `App.jsx` (filter warehouses ตาม `isStaff && branch_id`), `useStock.js` (scope key 'all'/warehouseId), `NotifBell.jsx` (balScope), `useSession.js` (branch_id/isStaff), `WarehouseCycle.jsx` (locked ตาม staff)

**สิ่งที่ต้องทำ:**
- [ ] **เก็บ `warehouses.find(main)` ที่เหลือ 3 จุดใน `Dashboard.jsx`** (บรรทัด ~2960 LotInfo รับ PO · ~3722 RF import ในใบโอน · ~3822 ใบโอน) → เปลี่ยนเป็น `mainWarehouse ||` (ตอนนี้ owner-only เลยยังไม่พัง แต่จะพังถ้าเปิดให้ staff)
- [ ] เช็ค `Report.jsx` (~2391 `isMainWh`) ว่า scope staff กระทบไหม
- [ ] สร้าง helper/hook กลาง เช่น `useBranchScope()` คืน `{ scope, isStaff, mainWarehouse, canSeeAllBranches }` แทนที่จะคำนวณ `isStaff && branch_id` ซ้ำในหลายไฟล์
- [ ] เขียนกฎ/คอมเมนต์ชัดเจน: "ห้าม `warehouses.find(main)` เดี่ยวๆ ในโค้ดที่ staff เข้าถึงได้"

**Acceptance:** ไม่มีจุดไหนอ้างคลังกลางด้วย `warehouses.find(main)` เดี่ยวในโค้ด staff-reachable · logic scope สาขามาจากแหล่งเดียว · เทสด้วย session staff แล้วเห็นยอดคลังกลางถูกทุกหน้า

---

### โจทย์ B3 — Code Cleanup (แตกไฟล์ + จัดระเบียบ) 🟡

**ปัญหา:** ไฟล์หน้าใหญ่มาก แก้ทีต้องระวังชนกัน + bundle เตือน chunk > 500KB ทุกครั้งที่ build · Inventory ยังค้างอยู่ในงาน "Code Cleanup initiative" รวมของระบบ (Maintenance เสร็จแล้ว v1.8.09)

| ไฟล์ | บรรทัด |
|---|---|
| `Dashboard.jsx` | ~4,863 |
| `Settings.jsx` | ~3,911 |
| `Report.jsx` | ~2,952 |
| `Warehouse.jsx` | ~2,050 |
| **bundle รวม** | ~1.7 MB (gzip ~613 KB) |

**สิ่งที่ต้องทำ:**
- [ ] แตก modal/section ย่อยใน Dashboard.jsx เป็น component แยก (Refill / Transfer / PO receive / LotInfo — ไฟล์ละ ~300-500 บรรทัด)
- [ ] แตก Settings.jsx (Master Data form / Import CM / Reconcile ฯลฯ)
- [ ] route-level code splitting (`React.lazy` + `Suspense`) ต่อแท็บ (Dashboard/คลัง/ตัดสต็อก/รายงาน/ตั้งค่า)
- [ ] `build.rollupOptions.output.manualChunks` แยก firebase / xlsx ออกจาก main
- [ ] ลบ dead code / คอมเมนต์ที่ลบออกไปแล้วแต่ยังค้าง (มีบล็อก `/* ลบออก: ... */` หลายจุด)

**Acceptance:** ไม่มีไฟล์หน้าเดียวเกิน ~1,500 บรรทัด · bundle warning หาย (ทุก chunk < 500KB) · แท็บแรกโหลดเร็วขึ้น
> ⚠️ ทำ **หลัง** B1 (React 19) เพื่อไม่ต้อง refactor 2 รอบ

---

### โจทย์ B4 — Guard ต้นเหตุบั๊กหน่วยเพี้ยน (unit-drift) 🔴

**ปัญหา:** `Settings.jsx → applyUpdateFromCM()` (บรรทัด ~207) sync หน่วยจาก Cost Manager เข้า `Inv_items` แต่**ไม่ rescale ยอดคงเหลือเดิม** เมื่อ unitUse เลื่อนระดับ — เคยทำ "แก้ว 500 (กระดาษ)" เพี้ยน ×50 (ใบ→แถว)

**สถานะ:** แก้ปลายเหตุ + กันฝั่งอ่านแล้ว (getLotQtyTotal เชื่อ totalQty) — **แต่ต้นเหตุยังเกิดซ้ำได้**

**สิ่งที่ต้องทำ:**
- [ ] ตรวจ factorToUse ของ unitUse ก่อน/หลัง sync ต่างกันไหม → ถ้าต่าง เตือน + เสนอ rescale `Inv_stock_balances`/`Inv_lots` ตามอัตราส่วน (หรือ block ไว้ใช้เครื่องมือแยก)
- [ ] เขียน movement/audit บันทึกการ rescale

**Acceptance:** sync หน่วยที่เปลี่ยน scale แล้วยอดจริงไม่เปลี่ยน (ตัวเลขที่โชว์เท่าเดิมก่อน/หลัง)

---

### โจทย์ B5 — ทวน Read Optimization ที่ค้างจาก V5 🟡

- [ ] ทวนโจทย์ V5 (30 มิ.ย.) เทียบโค้ดปัจจุบัน — ข้อไหนยังไม่ปิด (บางส่วนทำแล้ว: useItems/useStock shared hook, audit_logs query รายวัน+limit)
- [ ] เช็ค `Warehouse.jsx` ที่ subscribe `Inv_lots` ทั้ง collection (เปลี่ยนตอนทำ family view) ว่าเพิ่ม read เกินจำเป็นไหม
> ⚠️ V5 โจทย์ข้อ 4 "push_tokens" **ไม่ใช่ของ Inventory frontend** — เป็นของ `00 - Functions` (ดู D)

---

## C. เอกสาร

### C1 — เพิ่ม README สถาปัตยกรรม 🟡 (ยังไม่มีไฟล์)
ปัจจุบัน Inventory **ไม่มี README** เลย — คนใหม่/เจ้าของอ่านโครงสร้างไม่ได้
- [ ] สร้าง `README.md` ที่ root ของ Inventory ครอบคลุม:
  - Stack (React 18/Vite/Tailwind/Firebase) + วิธี dev/build/deploy (`gh-pages -d dist -t`)
  - โครงสร้างโฟลเดอร์ `src/` (pages / components / hooks / utils / constants)
  - Firestore collections `Inv_*` + ความหมาย + doc id pattern (`warehouseId_itemId`)
  - **โมเดลข้อมูลสำคัญ:** balance = source of truth · LOT lifecycle (totalQty = คงเหลือ + used + โอนออก) · unit ladder (unitLevels/factorToUse)
  - Session/role model (มาจาก Hub: role/apps/branch_id) + branch scoping
  - ความเชื่อมโยงกับ `00 - Functions` (reminder/summary/push) และ Cost Manager (sync หน่วย+ราคา)

### C2 — Changelog v5.5–5.7 🟢
- [ ] เขียน changelog สรุปฟีเจอร์ที่ทำไปแล้ว (family LOT view / reconcile / lotEnabled toggle / staff main-wh fix / dual timestamp / hide depleted LOT) — ไฟล์นี้เป็น *backlog* คนละอันกับ *changelog*

---

## D. ขอบเขตที่ **ไม่ใช่** ของ Inventory frontend (อยู่ที่ `00 - Functions`)

เพื่อกันสับสน — งานเหล่านี้อยู่ที่ Cloud Functions backend (`00 - Functions/functions/index.js`) **ไม่ต้องทำในมินิแอป Inventory:**
- 🔔 **Push / แจ้งเตือน / reminder ตามเวลา** — `remindMorningSend/AfternoonSend/MorningReceive/AfternoonReceive`, `dailyReminder`, `sendHubPush`
- 📊 **สรุปประจำวัน** — `dailySummary` (อ่าน Inv_cut_logs/waste/balances/warehouses/items/transfers/refill)
- ⚡ **push_tokens caching** (V5 โจทย์ข้อ 4) — เป็น optimization ฝั่ง Functions ล้วน
> ถ้าจะแตะงานพวกนี้ ต้องไปทำที่ `00 - Functions` + ระวังกฎ deploy (ห้าม deploy-all จาก codebase ไม่ครบ)

---

## E. Infra ร่วม (แจ้งไว้ — กระทบทุกแอป)

### E1 — Firestore Security Rules 🔴 (ต้องเจ้าของทำใน Firebase Console)
Project `mixue-cost-manager` เปิดให้เขียน/ลบ DB ได้โดยไม่ต้อง auth (พิสูจน์แล้ว: อ่าน/เขียนผ่าน REST + apiKey สาธารณะได้) — รวม `Inv_*` ทั้งหมด
- [ ] Publish `firestore.rules` ที่เตรียมไว้ + เพิ่ม anon/custom auth ในแอป
- ⚠️ กระทบทุกแอป ต้องวางแผนร่วม ไม่ใช่งาน Inventory เดี่ยว

---

## 📌 ลำดับแนะนำ

1. **A1 (กด Reconcile)** — ปิดหนี้ข้อมูล LOT ทำได้ทันที ไม่ต้องเขียนโค้ด
2. **B1 (React 19.2.7)** — พร้อมทำ โค้ดสะอาด แก้ 4 บรรทัด + เทส
3. **B4 (guard หน่วยเพี้ยน)** — สั้น กันเจ็บซ้ำ
4. **B2 (Branch Awareness)** — เก็บ warehouses.find + ทำ hook กลาง
5. **C1 (README)** — เขียนคู่ไปกับ B2/B3 (เข้าใจโครงสร้างชัดตอน refactor)
6. **B3 (Code Cleanup)** — งานใหญ่ ทำหลัง B1 เป็นรอบๆ
7. **E1 (Security Rules)** — สำคัญสุดเชิงความปลอดภัย แต่ต้องเจ้าของ + ข้ามแอป

---

*รวบรวมเมื่อ 8 กรกฎาคม 2026 — อ้างอิงสถานะโค้ด live v5.7.0*
