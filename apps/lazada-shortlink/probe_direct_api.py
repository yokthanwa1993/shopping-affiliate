#!/usr/bin/env python3

import hashlib
import json
import time

import browser_cookie3
import requests


COOKIE_PATH = r"C:\Users\yokthanwa1993\AppData\Local\Google\Chrome\User Data\Profile 6\Network\Cookies"
APP_KEY = "24677475"
API = "https://acs-m.lazada.co.th/h5/mtop.lazada.affiliate.lania.offer.getpromotionlinkfromjumpurl/1.1/"
JUMP_URL = "https://www.lazada.co.th/shop/mobiles"


def main():
    jar = browser_cookie3.chrome(cookie_file=COOKIE_PATH, domain_name="lazada.co.th")
    session = requests.Session()
    for cookie in jar:
        session.cookies.set(cookie.name, cookie.value, domain=cookie.domain, path=cookie.path)

    print("cookie_names", sorted({cookie.name for cookie in jar}))

    token_cookie = session.cookies.get("_m_h5_tk", domain=".lazada.co.th") or session.cookies.get("_m_h5_tk")
    print("token_cookie", token_cookie)
    if not token_cookie:
        raise SystemExit("missing _m_h5_tk")

    token = token_cookie.split("_", 1)[0]
    t_ms = str(int(time.time() * 1000))
    data = json.dumps({"jumpUrl": JUMP_URL}, separators=(",", ":"))
    sign = hashlib.md5(f"{token}&{t_ms}&{APP_KEY}&{data}".encode()).hexdigest()

    params = {
        "jsv": "2.6.1",
        "appKey": APP_KEY,
        "t": t_ms,
        "sign": sign,
        "api": "mtop.lazada.affiliate.lania.offer.getPromotionLinkFromJumpUrl",
        "v": "1.1",
        "type": "originaljson",
        "isSec": "1",
        "AntiCreep": "true",
        "timeout": "5000",
        "needLogin": "true",
        "dataType": "json",
        "sessionOption": "AutoLoginOnly",
        "x-i18n-language": "en",
        "x-i18n-regionID": "TH",
        "data": data,
    }
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.lazada.co.th/",
        "Origin": "https://www.lazada.co.th",
    }

    response = session.get(API, params=params, headers=headers, timeout=30)
    print("status", response.status_code)
    print(response.text)


if __name__ == "__main__":
    main()
