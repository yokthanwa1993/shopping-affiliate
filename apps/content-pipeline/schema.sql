-- content_items: 1 แถว = 1 คลิปคู่แข่ง (source → เจน → โพสต์)
CREATE TABLE IF NOT EXISTS content_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page TEXT, source_post_id TEXT UNIQUE, reel_url TEXT, caption TEXT,
  reactions INT, comments INT, shares INT, engagement INT, posted_date TEXT,
  platform TEXT, source_link TEXT,                 -- ลิงก์คู่แข่ง (Shopee/Lazada)
  original_video_id TEXT, original_video_url TEXT, -- ชี้ไฟล์ใน Discord #คลังต้นฉบับ
  generated_video_id TEXT,                         -- คลิปที่เจน (Discord #ประมวลผลแล้ว)
  our_affiliate_link TEXT,                         -- ลิงก์ affiliate ของเรา (ShopeeBridge)
  status TEXT DEFAULT 'new',                       -- new→downloaded→generated→linked→posted
  posted_to TEXT, posted_at TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_status ON content_items(status);
CREATE INDEX IF NOT EXISTS idx_eng ON content_items(engagement DESC);
