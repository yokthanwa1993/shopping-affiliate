# content-pipeline

ระบบดึงคลิปคู่แข่ง → เจนวิดีโอใหม่ → แปะลิงก์ affiliate ของเรา (ทำงานบน mac-mini ล้วน)

## Flow
```
pages.json (เพจคู่แข่ง)
  → fb_posts.py / fb_links.py  ดึงโพสต์+วิดีโอ+ลิงก์ Shopee/Lazada (จากคอมเมนต์)
  → store_clip.py              โหลดวิดีโอ → Discord #คลังต้นฉบับ + SQLite
  → hf_gen (higgsfield)        เจนคลิปใหม่ → Discord #ประมวลผลแล้ว
  → ShopeeBridge               ย่อลิงก์ affiliate ของเรา
  → โพสต์ + อัปเดต status
```

## เก็บข้อมูล
- **ไฟล์วิดีโอ** → Discord (ผ่าน admin-media-drive, ไม่ใส่แคปชั่น เก็บแค่ไฟล์)
- **ข้อมูล/ลิงก์/สถานะ** → SQLite `content_items`
  - DB จริง: `~/Library/Application Support/AffiliateAdmin/content.db` (นอก git)

## ใช้
```bash
export FB_TOKEN='EAAD...'   # token PPCA
python3 fb_posts.py <page> --videos       # ดึง+โหลด
python3 store_clip.py                      # ดึง top → เก็บ Discord+SQLite
```

## หมายเหตุ
- ต้อง pace การเรียก FB (rate-limit code 368) — ดึงเฉพาะโพสต์ใหม่ เช็ค source_post_id กันซ้ำ
- FB /posts ดึงได้แค่ token ที่มี Page Public Content Access
