# video-affiliate-local-publisher

Mac mini publisher สำหรับ organic Facebook Reel แบบ multi-page ใช้ SQLite local เป็น source of truth และทำงาน side-by-side โดยไม่ใช้ Cloudflare Worker/D1/Container เป็น runtime ของ posting lane

## Safety contract

ค่าเริ่มต้นใน repo fail closed:

- `writes_enabled=false`
- `scheduler_enabled=false`
- Page `enabled=false`
- HTTP write endpoint ปิด
- โพสต์จริงต้องผ่านทั้ง config + environment `PUBLISHER_ALLOW_WRITES=I_UNDERSTAND_EXTERNAL_SIDE_EFFECTS`
- scheduler ต้องผ่าน config + environment `PUBLISHER_SCHEDULER_ENABLED=true`
- หลังเรียก external `/post` แล้วผลไม่ชัดเจนจะเป็น `post_outcome_unknown`, block เพจและไม่ retry Reel; ถ้า process ตายคา `posting` ระบบจะจัดเป็น `stale_posting_review` หลัง 15 นาทีและรอผูก exact existing story เท่านั้น
- `success` ต้องเห็น Graph post `is_published=true`, comment เป็น Page, ข้อความตรง และ comment อยู่ใน story collection

## Production flow

1. อ่าน Studio SQLite ด้วย URI `mode=ro`
2. เลือกเฉพาะ `content_items.status='ready'` ที่มี Ready Message ID, Ready video attachment, Shopee/Lazada URL และ metadata แยกครบ
   - Studio source of truth คือ `ai_caption_text` (วลีชื่อสินค้า) + `ai_hashtags_json` (4 อัน); publisher ประกอบข้อความพร้อมโพสต์ตรง boundary ก่อนส่ง Facebook
   - `ai_post_caption` เป็น legacy/deprecated และห้ามใช้เป็น source of truth
   - Page ที่ตั้ง `reuse_success_from_page_id` จะเลือกได้เฉพาะ Content ID ที่ Page ต้นทางมี SQLite state=`success` แล้ว
   - `daily_success_limit` เป็น hard cap จำนวน Reel ที่โพสต์แล้วต่อวันตาม timezone ของ Page; นับตั้งแต่ `post_confirmed` แม้ comment/readback ยังรอ และ scheduler เลื่อนไปรอบวันถัดไปเมื่อครบเพดาน
3. resolve Discord `#ready` message สดจาก `ready_channel_id` และตรวจ attachment/buttons ตรง Studio DB; ไม่มี fallback ไป `#editor`
4. ถ้า Page เปิด `avatar_enabled` ให้ตรวจ Avatar local จาก `avatar_path` ด้วย ffprobe; ถ้าไฟล์หายหรือเสียให้ fail closed โดยไม่ fallback ไป Cloudflare. Page ที่ปิด Avatar ใช้ source MP4 ตรงๆ
5. ดาวน์โหลด source เข้า durable spool, ตรวจ MP4 ด้วย ffprobe/SHA-256 แล้ว atomic-copy ต้นฉบับก่อน Avatar ไป `source-archive/` แบบ 0600; archive fail จะหยุดก่อน Facebook write
6. compose Avatar ผ่าน local merge-rust `127.0.0.1:18080`
7. preflight source ตาม Page (`facebook_lite_eaad6` หรือ `idbridge_power_editor`) + Power Editor + Shopee CHEARB แบบ account-scoped และ fail closed เมื่อ source/account ไม่ตรง
8. โพสต์ Reel ผ่าน IDBridge แล้ว comment เป็น Page หลังรอ 30 วินาที. เพจเฉียบสร้าง Shopee shortlink ครั้งเดียวก่อนโพสต์และใช้ URL เดียวกันทั้งแคปชั่นกับคอมเมนต์ จึงเก็บ Sub1=Campaign/Sub2=Page และเว้น Sub3; Page อื่นยัง mint final link หลังได้ Post ID ด้วย Sub1=Campaign/Sub2=Page/Sub3=Post ตามเดิม. Power Editor Page posting ต้อง bind session cookies ของ account เดิมเพื่อ resolve Page token; upload/comment ใช้ Page token เป็น actor และห้าม fallback ข้าม account
9. Graph readback post/comment ก่อน mark SQLite `success`
10. advance `next_due_at` ตาม `interval_minutes` ของแต่ละ Page และ cleanup เฉพาะ spool; source archive คงถาวร
11. scheduler ไล่ดู due Page ตามลำดับอย่างยุติธรรม: Page ที่ติด reconcile/lease/source policy ถูกข้ามเฉพาะรอบนั้น แต่ยังเริ่ม post attempt ได้สูงสุดหนึ่ง Page ต่อ tick จึงไม่ burst catch-up
12. comment-only backlog แยก retry ทีละหนึ่ง attempt ต่อ tick ด้วย exponential backoff 5 นาทีถึง 6 ชั่วโมง; failure ทุกช่วงของ retry จะเลื่อนเวลารอบถัดไป และ Page ที่ lease ไม่ว่างจะถูกข้ามเพื่อไม่กีดกัน backlog อื่น; repair ใช้ story เดิมและไม่เรียก `/post`
13. startup/tick classifier ย้าย `posting` ที่เก่าและไม่มี Facebook IDs ไป `stale_posting_review`; recovery ต้องอ่าน story+video สด ตรวจ Page, caption digest, attachment target และเวลาใกล้ attempt ก่อน bind IDs เข้ารายการเดิม แล้วเดิน final link/comment/readback เท่านั้น

### แคปชั่นเพจเฉียบสำหรับโพสต์ใหม่

- เฉพาะ Page ID `1008898512617594` สร้าง Shopee shortlink หนึ่งครั้งก่อนโพสต์ วาง URL นั้นที่บรรทัดแรกในรูป `📌 พิกัด : <link>` และใช้ URL เดียวกันในคอมเมนต์หลังโพสต์
- การใช้ URL เดียวกันหมายถึง tracking ของเพจเฉียบคง `Sub1=Campaign` และ `Sub2=Page` แต่ไม่มี `Sub3=Post ID`; ระบบห้ามสร้าง URL ตัวที่สองเพื่อเติม Sub3
- บังคับ 3 บรรทัดติดกันโดยไม่มีบรรทัดว่าง: ลิงก์, ข้อความสินค้าสั้น, แฮชแท็ก 3 อัน
- ใช้ metadata แยกของ Studio เดิมแบบ read-only; เริ่มจาก 3 แฮชแท็กแรก และย่อแฮชแท็กแบบ deterministic เฉพาะเมื่อจำเป็นเพื่อให้ข้อความรวมไม่เกิน 130 ตัวอักษร
- ถ้ายังประกอบ 3 แฮชแท็กภายใน 130 ตัวอักษรไม่ได้ ให้หยุดก่อนเรียก Facebook `/post`
- Page อื่นยังใช้แคปชั่น link-free เดิม และการเปลี่ยนนี้ไม่แก้โพสต์เก่า

SQLite เก็บ leases, state transitions, source/media hash, post/comment IDs, failure ที่ redact แล้ว, duplicate guard ต่อ `(page_id, studio_content_id)`, per-Page reuse policy/daily cap, comment retry count/next retry, recovery states และ `source_archives` keyed by `(studio_content_id, source_sha256)`. Comment/verification failure ใช้ attempt เดิมเท่านั้น; ห้ามสร้าง Reel ซ้ำ

## Commands

รันจากโฟลเดอร์ app:

```bash
python3 main.py --config config.example.json migrate
python3 main.py --config config.example.json status
python3 main.py --config config.example.json run-once --page-id 100000000000000
python3 scripts/lookup_facebook_source.py --config config.example.json '<Facebook share/reel URL>'
python3 -m unittest discover -s test -v
python3 install_launchagent.py
```

`lookup_facebook_source.py` เป็น read-only: resolve Facebook share/reel URL ผ่าน HTTP ตรง แล้วไล่ `post_attempts → source_items/source_archives → Studio content_items` เพื่อคืน Content ID และ local archive path ของวิดีโอที่ใช้โพสต์จริง โดยไม่อ่านหรือแสดง token/cookie.

การ activate production ต้องทำหลัง explicit approval และ cutover owner เดิมแล้ว:

```bash
python3 install_launchagent.py --enable-writes --enable-scheduler
```

Recovery หลัง post สำเร็จแต่ comment/readback ล้ม:

```bash
PUBLISHER_ALLOW_WRITES=I_UNDERSTAND_EXTERNAL_SIDE_EFFECTS \
python3 main.py --config "$HOME/Library/Application Support/VideoAffiliatePublisher/config.json" \
reconcile-attempt --attempt-id ATTEMPT_ID
```

Recovery หลัง process ตายระหว่าง `/post` แต่พบ Reel เดิมแบบ exact:

```bash
PUBLISHER_ALLOW_WRITES=I_UNDERSTAND_EXTERNAL_SIDE_EFFECTS \
python3 main.py --config "$HOME/Library/Application Support/VideoAffiliatePublisher/config.json" \
recover-existing-story --attempt-id ATTEMPT_ID \
  --story-id PAGEID_POSTTAIL --video-id VIDEO_ID \
  --expected-caption-sha256 CAPTION_SHA256
```

## Cutover / rollback

- Cutover: ปิดเฉพาะ Worker `pages.post_hours` ของ Page ที่ย้าย; คง `is_active`, Ads settings, Worker/R2/D1 ไว้
- เก็บ rollback snapshot ใต้ Application Support mode 0600
- Rollback: ปิด local scheduler/write gate ก่อน แล้วคืนค่า Worker schedule จาก snapshot ห้ามเปิดสอง owner พร้อมกัน

Runtime paths:

- config/DB/assets/spool/proof: `~/Library/Application Support/VideoAffiliatePublisher/`
- ต้นฉบับก่อน Avatar: `~/Library/Application Support/VideoAffiliatePublisher/source-archive/`
- logs: `~/Library/Logs/VideoAffiliatePublisher/`
- LaunchAgent: `com.affiliate.video-affiliate-local-publisher`
- local health/status: `http://127.0.0.1:3110/{health,status}`

ห้ามเก็บ token/cookie/password ใน repo, config, SQLite, proof หรือ log. Config เก็บเฉพาะ identity selector/path/public URL; credential อยู่กับ IDBridge เท่านั้น
