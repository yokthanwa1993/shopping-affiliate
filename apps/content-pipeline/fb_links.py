#!/usr/bin/env python3
"""fb_links.py — ดึงโพสต์ทั้งเพจ + หาลิงก์ Shopee/Lazada ใน "แคปชั่น" และ "คอมเมนต์"
ใช้:  export FB_TOKEN='EAAD...'; python3 fb_links.py <page_id|url> [--max 300]
"""
import os, sys, re, json, time, urllib.request, urllib.parse, argparse

V = "v21.0"
# แคปชั่น + คอมเมนต์ (เอา from ด้วย เพื่อดูว่าเพจเป็นคนคอมเมนต์ลิงก์ไหม)
FIELDS = ("message,created_time,permalink_url,from,"
          "attachments{media_type},"
          "comments.limit(30){message,from{name,id}}")

SHOPEE = re.compile(r"(https?://)?(s\.shopee|shopee\.co|shp\.ee|shopee\.com|\.shopee\.)[^\s\)]*", re.I)
LAZADA = re.compile(r"(https?://)?(s\.lazada|lazada\.co|c\.lazada|lzd\.co|lazada\.com|\.lazada\.)[^\s\)]*", re.I)


def api(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        return {"__error__": json.loads(e.read().decode()).get("error", {}).get("message", "")}


def find_links(text):
    if not text:
        return [], []
    return [m.group(0) for m in SHOPEE.finditer(text)], [m.group(0) for m in LAZADA.finditer(text)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("page")
    ap.add_argument("--max", type=int, default=300)
    ap.add_argument("--token", default=os.environ.get("FB_TOKEN", ""))
    a = ap.parse_args()
    page = re.search(r"id=(\d+)", a.page)
    page = page.group(1) if page else (a.page if a.page.isdigit() else a.page)

    url = (f"https://graph.facebook.com/{V}/{page}/posts?"
           + urllib.parse.urlencode({"fields": FIELDS, "limit": "25", "access_token": a.token}))
    posts = []
    while url and len(posts) < a.max:
        d = api(url)
        if "__error__" in d:
            print("❌", d["__error__"]); break
        posts.extend(d.get("data", []))
        url = d.get("paging", {}).get("next")
        print(f"  ...ดึง {len(posts)} โพสต์", flush=True)
        time.sleep(0.3)
    posts = posts[:a.max]

    n_cap = n_com = n_any = n_video = 0
    rows = []
    for p in posts:
        cap_s, cap_l = find_links(p.get("message", ""))
        com_hits = []
        for c in p.get("comments", {}).get("data", []):
            s, l = find_links(c.get("message", ""))
            if s or l:
                who = (c.get("from", {}) or {}).get("name", "?")
                com_hits.append((who, (s + l)[0]))
        has_cap = bool(cap_s or cap_l)
        has_com = bool(com_hits)
        is_vid = any(at.get("media_type") in ("video", "video_inline")
                     for at in p.get("attachments", {}).get("data", []))
        if is_vid:
            n_video += 1
        if has_cap:
            n_cap += 1
        if has_com:
            n_com += 1
        if has_cap or has_com:
            n_any += 1
        rows.append({"date": p.get("created_time", "")[:10], "video": is_vid,
                     "cap_links": cap_s + cap_l, "com_links": com_hits,
                     "msg": (p.get("message", "") or "")[:45], "url": p.get("permalink_url", "")})

    print("\n" + "=" * 64)
    print(f"📊 เพจ {page} — วิเคราะห์ {len(posts)} โพสต์ ({n_video} เป็นวิดีโอ)")
    print(f"   มีลิงก์ในแคปชั่น : {n_cap} โพสต์")
    print(f"   มีลิงก์ในคอมเมนต์: {n_com} โพสต์")
    print(f"   มีลิงก์ (รวม)    : {n_any}/{len(posts)} โพสต์  = {100*n_any//max(len(posts),1)}%")
    print("=" * 64)
    print("\nตัวอย่าง 12 โพสต์แรกที่มีลิงก์:")
    shown = 0
    for r in rows:
        if not (r["cap_links"] or r["com_links"]) or shown >= 12:
            continue
        shown += 1
        vid = "🎬" if r["video"] else "  "
        print(f"\n{vid} [{r['date']}] {r['msg']}")
        if r["cap_links"]:
            print(f"     📝 แคปชั่น: {r['cap_links'][0]}")
        for who, link in r["com_links"][:2]:
            print(f"     💬 คอมเมนต์ ({who}): {link}")
    json.dump(rows, open(f"links_{page}.json", "w"), ensure_ascii=False, indent=2)
    print(f"\n✅ บันทึก → links_{page}.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
