# video-affiliate-local-publisher

Mac mini publisher สำหรับ organic Facebook Reel ของเพจเฉียบ ใช้ SQLite local เป็น source of truth และทำงาน side-by-side โดยไม่ใช้ Cloudflare Worker/D1/Container เป็น runtime ของ posting lane

## Safety contract

ค่าเริ่มต้นใน repo fail closed:

- `writes_enabled=false`
- `scheduler_enabled=false`
- Page `enabled=false`
- HTTP write endpoint ปิด
- โพสต์จริงต้องผ่านทั้ง config + environment `PUBLISHER_ALLOW_WRITES=I_UNDERSTAND_EXTERNAL_SIDE_EFFECTS`
- scheduler ต้องผ่าน config + environment `PUBLISHER_SCHEDULER_ENABLED=true`
- หลังเรียก external `/post` แล้วผลไม่ชัดเจนจะเป็น `post_outcome_unknown`, block เพจและไม่ retry Reel
- `success` ต้องเห็น Graph post `is_published=true`, comment เป็น Page, ข้อความตรง และ comment อยู่ใน story collection

## Production flow

1. อ่าน Studio SQLite ด้วย URI `mode=ro`
2. เลือก `content_items.status='ready'` ที่มี Editor Message ID, video attachment, Shopee URL และ caption ครบ
3. resolve Discord `#editor` message สดและตรวจ attachment/buttons ตรง Studio DB
4. ตรวจ Avatar local จาก `avatar_path` ด้วย ffprobe; ถ้าไฟล์หายหรือเสียให้ fail closed โดยไม่ fallback ไป Cloudflare
5. ดาวน์โหลด source เข้า durable spool, ตรวจ MP4 ด้วย ffprobe และ SHA-256
6. compose Avatar ผ่าน local merge-rust `127.0.0.1:18080`
7. preflight Facebook Lite + Power Editor + Shopee CHEARB
8. โพสต์ Reel ผ่าน IDBridge, mint final link Sub1=Campaign/Sub2=Page/Sub3=Post, รอ 30 วินาทีแล้ว comment เป็น Page
9. Graph readback post/comment ก่อน mark SQLite `success`
10. advance `next_due_at` ตาม interval 20 นาทีและ cleanup spool

SQLite เก็บ leases, state transitions, source/media hash, post/comment IDs, failure ที่ redact แล้ว, duplicate guard ต่อ `(page_id, studio_content_id)` และ recovery states. Comment/verification failure ใช้ `reconcile-attempt`; ห้ามสร้าง Reel ซ้ำ

## Commands

รันจากโฟลเดอร์ app:

```bash
python3 main.py --config config.example.json migrate
python3 main.py --config config.example.json status
python3 main.py --config config.example.json run-once --page-id 100000000000000
python3 -m unittest discover -s test -v
python3 install_launchagent.py
```

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

## Cutover / rollback

- Cutover: ปิดเฉพาะ Worker `pages.post_hours` ของ Page ที่ย้าย; คง `is_active`, Ads settings, Worker/R2/D1 ไว้
- เก็บ rollback snapshot ใต้ Application Support mode 0600
- Rollback: ปิด local scheduler/write gate ก่อน แล้วคืนค่า Worker schedule จาก snapshot ห้ามเปิดสอง owner พร้อมกัน

Runtime paths:

- config/DB/assets/spool/proof: `~/Library/Application Support/VideoAffiliatePublisher/`
- logs: `~/Library/Logs/VideoAffiliatePublisher/`
- LaunchAgent: `com.affiliate.video-affiliate-local-publisher`
- local health/status: `http://127.0.0.1:3110/{health,status}`

ห้ามเก็บ token/cookie/password ใน repo, config, SQLite, proof หรือ log. Config เก็บเฉพาะ identity selector/path/public URL; credential อยู่กับ IDBridge เท่านั้น
