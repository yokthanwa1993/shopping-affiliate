import base64
import io
import os
import struct
import time
import uuid

import pyotp
import requests
from Crypto.Cipher import AES, PKCS1_v1_5
from Crypto.PublicKey import RSA
from Crypto.Random import get_random_bytes
from flask import Flask, jsonify, request


app = Flask(__name__)
IP_CHECK_URL = os.environ.get("IP_CHECK_URL", "https://api.ipify.org?format=json")


def build_proxy_config(proxy: str) -> dict:
    normalized = str(proxy or "").strip()
    if not normalized:
        return {}
    return {"http": normalized, "https": normalized}


def probe_public_ip(proxy: str = "") -> dict:
    session = requests.Session()
    session.trust_env = False
    if proxy:
        session.proxies.update(build_proxy_config(proxy))

    started_at = time.time()
    response = session.get(IP_CHECK_URL, timeout=30)
    response.raise_for_status()

    payload = response.json()
    ip = str(payload.get("ip") or "").strip()
    elapsed_ms = round((time.time() - started_at) * 1000)
    return {
        "ok": True,
        "ip": ip,
        "status_code": response.status_code,
        "elapsed_ms": elapsed_ms,
        "used_proxy": bool(proxy),
        "check_url": IP_CHECK_URL,
    }


class FacebookPasswordEncryptor:
    @staticmethod
    def get_public_key(proxy: str = ""):
        response = requests.post(
            "https://b-graph.facebook.com/pwd_key_fetch",
            params={
                "version": "2",
                "flow": "CONTROLLER_INITIALIZATION",
                "method": "GET",
                "fb_api_req_friendly_name": "pwdKeyFetch",
                "fb_api_caller_class": "com.facebook.auth.login.AuthOperations",
                "access_token": "438142079694454|fc0a7caa49b192f64f6f5a6d9643bb28",
            },
            proxies=build_proxy_config(proxy),
            timeout=60,
        )
        response.raise_for_status()
        payload = response.json()
        return payload.get("public_key"), str(payload.get("key_id", "25"))

    @staticmethod
    def encrypt(password: str, proxy: str = "", public_key=None, key_id="25") -> str:
        if public_key is None:
            public_key, key_id = FacebookPasswordEncryptor.get_public_key(proxy=proxy)

        rand_key = get_random_bytes(32)
        iv = get_random_bytes(12)

        pubkey = RSA.import_key(public_key)
        cipher_rsa = PKCS1_v1_5.new(pubkey)
        encrypted_rand_key = cipher_rsa.encrypt(rand_key)

        cipher_aes = AES.new(rand_key, AES.MODE_GCM, nonce=iv)
        current_time = int(time.time())
        cipher_aes.update(str(current_time).encode("utf-8"))
        encrypted_passwd, auth_tag = cipher_aes.encrypt_and_digest(password.encode("utf-8"))

        buf = io.BytesIO()
        buf.write(bytes([1, int(key_id)]))
        buf.write(iv)
        buf.write(struct.pack("<h", len(encrypted_rand_key)))
        buf.write(encrypted_rand_key)
        buf.write(auth_tag)
        buf.write(encrypted_passwd)

        encoded = base64.b64encode(buf.getvalue()).decode("utf-8")
        return f"#PWD_FB4A:2:{current_time}:{encoded}"


class FacebookLogin:
    API_URL = "https://b-graph.facebook.com/auth/login"
    ACCESS_TOKEN = "350685531728|62f8ce9f74b12f84c123cc23437a4a32"
    API_KEY = "882a8490361da98702bf97a021ddc14d"
    SIG = "214049b9f17c38bd767de53752b53946"

    BASE_HEADERS = {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-net-hni": "45201",
        "zero-rated": "0",
        "x-fb-sim-hni": "45201",
        "x-fb-connection-quality": "EXCELLENT",
        "x-fb-friendly-name": "authenticate",
        "x-fb-connection-bandwidth": "78032897",
        "x-tigon-is-retry": "False",
        "authorization": "OAuth null",
        "x-fb-connection-type": "WIFI",
        "x-fb-device-group": "3342",
        "priority": "u=3,i",
        "x-fb-http-engine": "Liger",
        "x-fb-client-ip": "True",
        "x-fb-server-cluster": "True",
    }

    def __init__(self, identifier: str, password: str, totp_secret: str = "", machine_id: str = "", proxy: str = "", target_app: str = "FB_LITE"):
        self.identifier = identifier.strip()
        self.totp_secret = (totp_secret or "").replace(" ", "")
        self.proxy = (proxy or "").strip()
        self.target_app = target_app or "FB_LITE"
        self.password = password if password.startswith("#PWD_FB4A") else FacebookPasswordEncryptor.encrypt(password, proxy=self.proxy)

        self.session = requests.Session()
        self.session.trust_env = False
        if self.proxy:
            self.session.proxies.update(build_proxy_config(self.proxy))

        self.device_id = str(uuid.uuid4())
        self.adid = str(uuid.uuid4())
        self.secure_family_device_id = str(uuid.uuid4())
        self.machine_id = (machine_id or "").strip() or uuid.uuid4().hex[:24]
        self.jazoest = str(int(time.time()))[-5:]
        self.sim_serial = uuid.uuid4().hex[:20]

        self.headers = self._build_headers()
        self.data = self._build_data()

    def _build_headers(self):
        headers = dict(self.BASE_HEADERS)
        headers["x-fb-request-analytics-tags"] = '{"network_tags":{"product":"350685531728","retry_attempt":"0"},"application_tags":"unknown"}'
        headers["user-agent"] = "Dalvik/2.1.0 (Linux; U; Android 9; 23113RKC6C Build/PQ3A.190705.08211809) [FBAN/FB4A;FBAV/417.0.0.33.65;FBPN/com.facebook.katana;FBLC/vi_VN;FBBV/480086274;FBCR/MobiFone;FBMF/Redmi;FBBD/Redmi;FBDV/23113RKC6C;FBSV/9;FBCA/x86:armeabi-v7a;FBDM/{density=1.5,width=1280,height=720};FB_FW/1;FBRV/0;]"
        return headers

    def _build_data(self):
        return {
            "format": "json",
            "email": self.identifier,
            "password": self.password,
            "credentials_type": "password",
            "generate_session_cookies": "1",
            "locale": "vi_VN",
            "client_country_code": "VN",
            "api_key": self.API_KEY,
            "access_token": self.ACCESS_TOKEN,
            "adid": self.adid,
            "device_id": self.device_id,
            "generate_analytics_claim": "1",
            "community_id": "",
            "linked_guest_account_userid": "",
            "cpl": "true",
            "try_num": "1",
            "family_device_id": self.device_id,
            "secure_family_device_id": self.secure_family_device_id,
            "sim_serials": f'["{self.sim_serial}"]',
            "openid_flow": "android_login",
            "openid_provider": "google",
            "openid_tokens": "[]",
            "account_switcher_uids": f'["{self.identifier}"]',
            "fb4a_shared_phone_cpl_experiment": "fb4a_shared_phone_nonce_cpl_at_risk_v3",
            "fb4a_shared_phone_cpl_group": "enable_v3_at_risk",
            "enroll_misauth": "false",
            "error_detail_type": "button_with_disabled",
            "source": "login",
            "machine_id": self.machine_id,
            "jazoest": self.jazoest,
            "meta_inf_fbmeta": "V2_UNTAGGED",
            "advertiser_id": self.adid,
            "encrypted_msisdn": "",
            "currently_logged_in_userid": "0",
            "fb_api_req_friendly_name": "authenticate",
            "fb_api_caller_class": "Fb4aAuthHandler",
            "sig": self.SIG,
        }

    def _convert_token(self, access_token: str):
        response = self.session.post(
            "https://api.facebook.com/method/auth.getSessionforApp",
            data={
                "access_token": access_token,
                "format": "json",
                "new_app_id": "275254692598279" if self.target_app == "FB_LITE" else self.target_app,
                "generate_session_cookies": "1",
            },
            timeout=60,
        )
        payload = response.json()
        token = str(payload.get("access_token") or "").strip()
        if not token:
            return None, []
        return token, payload.get("session_cookies", []) or []

    def _handle_2fa(self, error_data):
        if not self.totp_secret:
            return {"success": False, "error": "2FA required but not provided"}

        twofactor_code = pyotp.TOTP(self.totp_secret).now()
        response = self.session.post(
            self.API_URL,
            data={
                "locale": "vi_VN",
                "format": "json",
                "email": self.identifier,
                "device_id": self.device_id,
                "access_token": self.ACCESS_TOKEN,
                "generate_session_cookies": "true",
                "generate_machine_id": "1",
                "twofactor_code": twofactor_code,
                "credentials_type": "two_factor",
                "error_detail_type": "button_with_disabled",
                "first_factor": error_data["login_first_factor"],
                "password": self.password,
                "userid": error_data["uid"],
                "machine_id": error_data["login_first_factor"],
            },
            headers=self.headers,
            timeout=60,
        )
        payload = response.json()
        if "access_token" in payload:
            return {
                "success": True,
                "access_token": payload["access_token"],
                "session_cookies": payload.get("session_cookies", []),
            }
        return {
            "success": False,
            "error": payload.get("error", {}).get("message", "2FA failed"),
        }

    def login(self):
        response = self.session.post(
            self.API_URL,
            headers=self.headers,
            data=self.data,
            timeout=60,
        )
        payload = response.json()

        if "access_token" in payload:
            original_token = payload["access_token"]
            converted_token, cookies = self._convert_token(original_token)
            if converted_token:
                return {
                    "success": True,
                    "token": converted_token,
                    "token_type": "FB_LITE (EAAD6V7)",
                    "cookies": cookies,
                }
            return {
                "success": True,
                "token": original_token,
                "token_type": "FB Android (EAAAAU)",
                "cookies": payload.get("session_cookies", []),
            }

        if "error" in payload:
            error_data = payload.get("error", {}).get("error_data", {})
            if "login_first_factor" in error_data and "uid" in error_data:
                twofa = self._handle_2fa(error_data)
                if not twofa.get("success"):
                    return {"success": False, "error": twofa.get("error", "2FA failed")}
                converted_token, cookies = self._convert_token(twofa["access_token"])
                if converted_token:
                    return {
                        "success": True,
                        "token": converted_token,
                        "token_type": "FB_LITE (EAAD6V7)",
                        "cookies": cookies,
                    }
                return {
                    "success": True,
                    "token": twofa["access_token"],
                    "token_type": "FB Android (EAAAAU)",
                    "cookies": twofa.get("session_cookies", []),
                }

            return {
                "success": False,
                "error": payload["error"].get("message", "Unknown error"),
                "error_user_msg": payload["error"].get("error_user_msg"),
            }

        return {"success": False, "error": "Unknown response format"}


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS, GET"
    return response


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "token", "version": 1})


@app.route("/api/comment-token", methods=["POST", "OPTIONS"])
def comment_token():
    if request.method == "OPTIONS":
        return ("", 204)

    body = request.get_json(silent=True) or {}
    identifier = str(body.get("uid") or body.get("username") or "").strip()
    password = str(body.get("password") or "").strip()
    totp_secret = str(body.get("2fa") or body.get("totp_secret") or "").strip()
    datr = str(body.get("datr") or "").strip()
    proxy = str(body.get("proxy") or "").strip()
    target_app = str(body.get("target_app") or "FB_LITE").strip() or "FB_LITE"

    if not identifier or not password:
        return jsonify({"success": False, "error": "Missing uid/username or password"}), 400

    try:
        client = FacebookLogin(
            identifier=identifier,
            password=password,
            totp_secret=totp_secret,
            machine_id=datr,
            proxy=proxy,
            target_app=target_app,
        )
        result = client.login()
        status = 200 if result.get("success") else 400
        return jsonify(result), status
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/proxy-check", methods=["POST", "OPTIONS"])
def proxy_check():
    if request.method == "OPTIONS":
        return ("", 204)

    body = request.get_json(silent=True) or {}
    proxy = str(body.get("proxy") or "").strip()

    try:
        direct_result = probe_public_ip("")
    except Exception as exc:
        direct_result = {
            "ok": False,
            "error": str(exc),
            "used_proxy": False,
            "check_url": IP_CHECK_URL,
        }

    if not proxy:
        return jsonify({
            "success": True,
            "proxy_provided": False,
            "direct": direct_result,
        })

    try:
        proxy_result = probe_public_ip(proxy)
        return jsonify({
            "success": True,
            "proxy_provided": True,
            "proxy": proxy_result,
            "direct": direct_result,
            "proxy_changes_ip": (
                bool(proxy_result.get("ok")) and
                bool(direct_result.get("ok")) and
                proxy_result.get("ip") != direct_result.get("ip")
            ),
        })
    except Exception as exc:
        return jsonify({
            "success": False,
            "proxy_provided": True,
            "proxy": {
                "ok": False,
                "error": str(exc),
                "used_proxy": True,
                "check_url": IP_CHECK_URL,
            },
            "direct": direct_result,
        }), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "80")))
