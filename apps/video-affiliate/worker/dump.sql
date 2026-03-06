PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image_url TEXT,
    access_token TEXT NOT NULL,
    post_interval_minutes INTEGER DEFAULT 60,
    is_active INTEGER DEFAULT 1,
    last_post_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
, post_hours TEXT DEFAULT '', bot_id TEXT DEFAULT 'default');
INSERT INTO "pages" VALUES('1008898512617594','เฉียบ','https://scontent-kul3-1.xx.fbcdn.net/v/t39.30808-1/499229706_996057189365646_7207459278022256674_n.jpg?stp=dst-jpg_s200x200_tt6&_nc_cat=109&ccb=1-7&_nc_sid=f907e8&_nc_ohc=_nlcoya283IQ7kNvwGs1ZPB&_nc_oc=AdmnWUH3xySM27CIPpuHUyLeKanryjy-1lL3ZUj-4sTYVXtAbN03uc0P7NdNHOmfB6M&_nc_zt=24&_nc_ht=scontent-kul3-1.xx&edm=AGaHXAAEAAAA&_nc_gid=PUp0hWR3sdT8_4NivPSELw&_nc_tpa=Q5bMBQF4YTcZ5UNFUn2b0Z030iUPRFBt6xknVWK6h8oVsYTUZehyK-b8Dpq2qPPj2tuJSwwyZB3oIBX_&oh=00_Afu4aF86naJVcrNekkSU9XqZ7yvtWTSGOwdq93um67zyUw&oe=699E69F3','EAAChZCKmUTDcBQ03U34hKF1zmJfljWBWqtYSs75X6own2jzzNEXFZAE71PwDAkPJkEYJQ4gMVD0AlBDyExxvP5RHEnvG7SbJ04PlF89TIpCMkYwFEiI9qqVmbLBhbRP3AbqdPJzxCeFOqJAyZA8ZCI9nTZCJX1jRp4XwvZBEPGYNC2hDalYyGQHyHXs7DersuYHBy4UCr6rQwj7ZC524t0c6mWX',60,1,'2026-02-22T16:45:34.577Z','2026-02-20 18:48:37','2026-02-20 18:53:35','1:54,2:14,3:43,4:22,5:08,6:54,7:55,8:39,9:13,10:58,11:43,12:14,13:22,14:32,15:24,16:46,17:05,18:43,19:37,20:20,21:30,22:29,23:46,24:28','EAAD6V7os0gcBQ9YArsmi0HDX5YI9Uprr8wl1uacOJLuPoxJerJz7ZB4cjD2nhow8IyMzqStYZC2k3laMKk57SsiWLpW8dMT8YsQ9bIVZCu9IBorBduAmqOqGZB5VnpZAnRV1svOIq2hbYiJdgw7OGGs3joZAHaYTfl5M6ksnAZBNG15BfB9vwSxDMS065mzgvfzeG6blxeNZAH5fTtTGimd0rwZDZD','default');
CREATE TABLE post_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')), bot_id TEXT DEFAULT 'default',
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE TABLE post_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    fb_post_id TEXT,
    fb_reel_url TEXT,
    posted_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'success', -- success, failed
    error_message TEXT, bot_id TEXT DEFAULT 'default',
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
INSERT INTO "post_history" VALUES(1,'9f136bef','1008898512617594','935878009117736',NULL,'2026-02-20T18:53:58.333Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(2,'561de202','1008898512617594','1437445867924803',NULL,'2026-02-20T23:53:30.553Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(3,'2705243e','1008898512617594','1380055493894879',NULL,'2026-02-21T00:54:29.736Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(4,'6c426f27','1008898512617594','1604868427325546',NULL,'2026-02-21T01:38:29.736Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(5,'17c81fb5','1008898512617594','26348984008053314',NULL,'2026-02-21T02:12:30.213Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(6,'4dd2bfe7','1008898512617594','1571972770704145',NULL,'2026-02-21T03:57:30.548Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(7,'3f133775','1008898512617594','1671720100933518',NULL,'2026-02-21T04:42:30.669Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(8,'83602a8b','1008898512617594','3508202869336068',NULL,'2026-02-21T05:13:29.816Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(9,'d19a2649','1008898512617594','1647518102913980',NULL,'2026-02-21T06:21:18.166Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(10,'48a59e8e','1008898512617594','1418020770365063',NULL,'2026-02-21T07:31:17.346Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(11,'12a5d7d7','1008898512617594','1442323927332214',NULL,'2026-02-21T08:23:16.759Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(12,'fdab41e3','1008898512617594','2406531173130739',NULL,'2026-02-21T09:45:18.720Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(13,'6b281a33','1008898512617594','1447717286737618',NULL,'2026-02-21T10:04:16.541Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(14,'07fb7ab0','1008898512617594','1978287846059371',NULL,'2026-02-21T11:42:33.661Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(15,'be4df424','1008898512617594','875895762128390',NULL,'2026-02-21T12:36:30.064Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(16,'c7c8065c','1008898512617594','1928921891040956',NULL,'2026-02-21T13:19:30.060Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(17,'4f3f8b15','1008898512617594','882427011089015',NULL,'2026-02-21T14:29:30.067Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(18,'906dea22','1008898512617594','1485071753273258',NULL,'2026-02-21T15:28:30.112Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(19,'7d216668','1008898512617594',NULL,NULL,'2026-02-21T16:45:31.712Z','failed','เราได้จำกัดจำนวนการโพสต์ แสดงความเห็น หรือทำสิ่งอื่นๆ ของคุณเป็นระยะเวลานึงเพื่อป้องกันการสแปมในชุมชน คุณสามารถลองใหม่อีกครั้งในภายหลัง เรียนรู้เพิ่มเติม','default');
INSERT INTO "post_history" VALUES(20,'c2c62c79','1008898512617594',NULL,NULL,'2026-02-21T16:46:30.067Z','failed','เราได้จำกัดจำนวนการโพสต์ แสดงความเห็น หรือทำสิ่งอื่นๆ ของคุณเป็นระยะเวลานึงเพื่อป้องกันการสแปมในชุมชน คุณสามารถลองใหม่อีกครั้งในภายหลัง เรียนรู้เพิ่มเติม','default');
INSERT INTO "post_history" VALUES(21,'c2c62c79','1008898512617594',NULL,NULL,'2026-02-21T16:47:30.058Z','failed','เราได้จำกัดจำนวนการโพสต์ แสดงความเห็น หรือทำสิ่งอื่นๆ ของคุณเป็นระยะเวลานึงเพื่อป้องกันการสแปมในชุมชน คุณสามารถลองใหม่อีกครั้งในภายหลัง เรียนรู้เพิ่มเติม','default');
INSERT INTO "post_history" VALUES(22,'7d216668','1008898512617594','1329145495904808',NULL,'2026-02-21T18:53:30.085Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(23,'c2c62c79','1008898512617594','1076638174628267',NULL,'2026-02-21T19:13:30.050Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(24,'e1151958','1008898512617594','2015066009071136',NULL,'2026-02-21T20:42:30.077Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(25,'6d1646fb','1008898512617594','915303568154177',NULL,'2026-02-21T21:21:30.020Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(26,'7bcf28d6','1008898512617594','1916674188968174',NULL,'2026-02-22T03:57:40.620Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(27,'96c43cab','1008898512617594','1713187273008458',NULL,'2026-02-22T04:42:40.596Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(28,'d86a86dd','1008898512617594','1447327970185769',NULL,'2026-02-22T05:13:39.628Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(29,'de0540e4','1008898512617594','1238720384455301',NULL,'2026-02-22T06:21:39.434Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(30,'20e766f9','1008898512617594','2250829172110266',NULL,'2026-02-22T07:31:34.984Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(31,'a1206e4e','1008898512617594','3324019814421634',NULL,'2026-02-22T08:23:34.960Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(32,'36916e3c','1008898512617594','939843215282424',NULL,'2026-02-22T09:45:35.668Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(33,'1bb32f13','1008898512617594','1240860190846633',NULL,'2026-02-22T10:04:34.949Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(34,'8bbd4da0','1008898512617594','744538241849147',NULL,'2026-02-22T11:42:34.944Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(35,'ec712056','1008898512617594','4413759918910913',NULL,'2026-02-22T12:36:34.928Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(36,'02bde345','1008898512617594','1575545823741248',NULL,'2026-02-22T13:19:33.064Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(37,'2517a6ad','1008898512617594','925722186523527',NULL,'2026-02-22T14:29:33.061Z','success',NULL,'default');
INSERT INTO "post_history" VALUES(38,'6441b061','1008898512617594','1854151768482156',NULL,'2026-02-22T16:45:34.577Z','success',NULL,'default');
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO "settings" VALUES('default_interval','60','2026-02-20 15:45:16');
INSERT INTO "settings" VALUES('max_posts_per_day','48','2026-02-20 15:45:16');
CREATE TABLE d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" VALUES(1,'0001_multi-tenant.sql','2026-02-22 13:51:44');
CREATE TABLE allowed_users (
    telegram_id INTEGER PRIMARY KEY,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO "allowed_users" VALUES(1125203387,'yok','2026-02-22 13:52:02');
INSERT INTO "allowed_users" VALUES(1344057381,'Thanwa','2026-02-22 15:00:30');
CREATE TABLE channels (bot_id TEXT PRIMARY KEY, bot_token TEXT NOT NULL UNIQUE, bot_username TEXT, owner_telegram_id INTEGER NOT NULL, name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "channels" VALUES('8328894625','8328894625:AAEgMQwFeBkTLTYP-s5feVUsc7B64jTInAs','chearb_bot',1344057381,'Chearb','2026-02-22 15:09:08');
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" VALUES('post_history',38);
INSERT INTO "sqlite_sequence" VALUES('d1_migrations',1);
CREATE INDEX idx_post_queue_status ON post_queue(status);
CREATE INDEX idx_post_queue_scheduled ON post_queue(scheduled_at);
CREATE INDEX idx_post_history_page ON post_history(page_id);
CREATE INDEX idx_post_history_posted ON post_history(posted_at);
CREATE INDEX idx_pages_active ON pages(is_active);
CREATE INDEX idx_pages_bot_id ON pages(bot_id);
CREATE INDEX idx_post_queue_bot_id ON post_queue(bot_id);
CREATE INDEX idx_post_history_bot_id ON post_history(bot_id);
