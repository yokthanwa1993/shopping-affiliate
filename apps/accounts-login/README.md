# Shopee Session Sync — iPad App (SwiftUI)

แอป iPad สำหรับ **ดึง cookie (รวม AC_CERT_D) จาก session Shopee ในแอป** แล้วส่งไปเครื่องบ้าน
ให้ CLI (`shorten_pure.py`) ใช้ย่อลิงก์/แก้ CTA ได้แม้คุณอยู่นอกบ้าน

## หลักการ
- แอปมี **WebView ของตัวเอง** → คุณ login Shopee + ผ่าน captcha ในแอป (มนุษย์ทำเอง)
- แอปอ่าน cookie ของ WebView ตัวเอง (`WKHTTPCookieStore` ได้ httpOnly + AC_CERT_D)
- ส่งไป **bridge เครื่องบ้าน** ผ่าน Tailscale → เขียน `cookies.json` → CLI ย่อได้เลย
- **iPad = session เดียวของทั้งระบบ** (เครื่องบ้านไม่ login เอง) → ไม่มี concurrent-session = ไม่โดน captcha จากการสลับ device

---

## สิ่งที่ต้องมี
1. **Mac + Xcode** (ลงจาก App Store ฟรี)
2. **Apple ID** (ฟरी provisioning ลงแอปบน iPad ได้ 7 วัน/รอบ) หรือ **Apple Developer $99/ปี** (ลงยาว)
3. **Tailscale** (ฟรี) ลงทั้ง Mac บ้าน + iPad → iPad คุยกับเครื่องบ้านได้จากทุกที่

---

## ขั้นตอนสร้างโปรเจกต์ใน Xcode
1. เปิด Xcode → **File → New → Project → iOS → App**
   - Product Name: `ShopeeSessionSync`
   - Interface: **SwiftUI** | Language: **Swift**
   - เลือกโฟลเดอร์เก็บ (เช่น `/Users/yok/Developer/shopee/ipad-app/`)
2. ลบไฟล์ `ContentView.swift` + `<ชื่อ>App.swift` ที่ Xcode สร้างให้ (Move to Trash)
3. **ลากไฟล์จากโฟลเดอร์ `Sources/` ทั้งหมดเข้า Xcode** (เลือก "Copy items if needed"):
   - `ShopeeSessionSyncApp.swift`
   - `AppModel.swift`
   - `WebView.swift`
   - `ContentView.swift`
4. ตั้งค่าโปรเจกต์ (target → **Info** / **Signing**):
   - **Signing & Capabilities** → เลือก Team (Apple ID ของคุณ)
   - **Deployment**: iOS 16.0+, Devices = iPad (หรือ Universal)
5. เพิ่มค่าใน **Info.plist** (target → Info → Custom iOS Target Properties → กด +):
   - `App Transport Security Settings` (Dictionary)
     - `Allow Arbitrary Loads` = **YES** (เพราะ bridge เป็น http ผ่าน Tailscale)
   - `Privacy - Local Network Usage Description` = `ส่ง session ไปเครื่องบ้านผ่าน Tailscale`

> ถ้ามี XcodeGen: มี `project.yml` ให้แล้ว รัน `xcodegen generate` ข้ามขั้น 1-4 ได้

---

## เปิดฝั่งเครื่องบ้าน (bridge)
ให้ bridge รับจากภายนอกได้ (Tailscale):
```bash
cd /Users/yok/Developer/shopee/4-no-browser
BRIDGE_HOST=0.0.0.0 ./.venv/bin/python bridge.py
```
หา Tailscale IP เครื่องบ้าน:
```bash
tailscale ip -4        # ได้เลข 100.x.x.x
```

---

## ใช้งาน
1. เปิดแอปบน iPad → กดปุ่ม ⚙️ → ใส่ **Bridge URL** = `http://<tailscale-ip>:8799/session`
2. ในแอป: login Shopee → ถ้ามี captcha ก็ผ่านซะ
3. แอป **auto-sync ทุก 2 นาที** + หลังโหลดหน้าเสร็จ (หรือกดปุ่ม 🔄 Sync เอง)
4. ไฟดวงเขียว + "AC_CERT_D: มี ✓" = cookie สดถึงเครื่องบ้านแล้ว
5. เครื่องบ้านย่อลิงก์ได้เลย (`shorten_pure.py`) โดยไม่ต้อง login เอง

## กฎทอง (กัน captcha)
- **login Shopee แค่ในแอป iPad ที่เดียว** — อย่า login บัญชีเดิมใน Opera/Chrome เครื่องอื่นอีก
- iPad = session เดียว ติดตัวไปไหนก็ sync ให้บ้านได้ → cert อยู่ยาว ไม่โดนเพิกถอน
