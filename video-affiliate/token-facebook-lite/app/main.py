import base64
import io
import random
import string
import struct
import time
import uuid
from typing import Any

import pyotp
import requests
from Crypto.Cipher import AES, PKCS1_v1_5
from Crypto.PublicKey import RSA
from Crypto.Random import get_random_bytes
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


class FacebookPasswordEncryptor:
    PWD_KEY_URL = "https://b-graph.facebook.com/pwd_key_fetch"
    PWD_KEY_ACCESS_TOKEN = "438142079694454|fc0a7caa49b192f64f6f5a6d9643bb28"

    @staticmethod
    def get_public_key(timeout: int = 30) -> tuple[str, str]:
        response = requests.post(
            FacebookPasswordEncryptor.PWD_KEY_URL,
            params={
                "version": "2",
                "flow": "CONTROLLER_INITIALIZATION",
                "method": "GET",
                "fb_api_req_friendly_name": "pwdKeyFetch",
                "fb_api_caller_class": "com.facebook.auth.login.AuthOperations",
                "access_token": FacebookPasswordEncryptor.PWD_KEY_ACCESS_TOKEN,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()

        public_key = payload.get("public_key")
        key_id = str(payload.get("key_id", "25"))
        if not public_key:
            raise RuntimeError("facebook public key not returned")

        return public_key, key_id

    @staticmethod
    def encrypt(password: str, timeout: int = 30) -> str:
        public_key, key_id = FacebookPasswordEncryptor.get_public_key(timeout=timeout)

        rand_key = get_random_bytes(32)
        iv = get_random_bytes(12)

        pubkey = RSA.import_key(public_key)
        cipher_rsa = PKCS1_v1_5.new(pubkey)
        encrypted_rand_key = cipher_rsa.encrypt(rand_key)

        cipher_aes = AES.new(rand_key, AES.MODE_GCM, nonce=iv)
        current_time = int(time.time())
        cipher_aes.update(str(current_time).encode("utf-8"))
        encrypted_password, auth_tag = cipher_aes.encrypt_and_digest(password.encode("utf-8"))

        buffer = io.BytesIO()
        buffer.write(bytes([1, int(key_id)]))
        buffer.write(iv)
        buffer.write(struct.pack("<h", len(encrypted_rand_key)))
        buffer.write(encrypted_rand_key)
        buffer.write(auth_tag)
        buffer.write(encrypted_password)

        encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
        return f"#PWD_FB4A:2:{current_time}:{encoded}"


class FacebookAppTokens:
    APPS = {
        "FB_ANDROID": "350685531728",
        "MESSENGER_ANDROID": "256002347743983",
        "FB_LITE": "275254692598279",
        "MESSENGER_LITE": "200424423651082",
        "ADS_MANAGER_ANDROID": "438142079694454",
        "PAGES_MANAGER_ANDROID": "121876164619130",
    }

    @staticmethod
    def get_app_id(app_key: str) -> str | None:
        return FacebookAppTokens.APPS.get(app_key)

    @staticmethod
    def extract_token_prefix(token: str) -> str:
        for index, char in enumerate(token):
            if char.islower():
                return token[:index]
        return token


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

    def __init__(
        self,
        identifier: str,
        password: str,
        twofa_secret: str = "",
        machine_id: str | None = None,
        target_app: str = "FB_LITE",
        timeout: int = 30,
    ):
        self.identifier = identifier
        self.twofa_secret = twofa_secret.replace(" ", "") if twofa_secret else ""
        self.timeout = timeout
        self.target_app = target_app

        if password.startswith("#PWD_FB4A"):
            self.password = password
        else:
            self.password = FacebookPasswordEncryptor.encrypt(password, timeout=timeout)

        self.session = requests.Session()

        self.device_id = str(uuid.uuid4())
        self.adid = str(uuid.uuid4())
        self.secure_family_device_id = str(uuid.uuid4())
        self.machine_id = machine_id if machine_id else self._generate_machine_id()
        self.jazoest = "".join(random.choices(string.digits, k=5))
        self.sim_serial = "".join(random.choices(string.digits, k=20))

        self.headers = self._build_headers()
        self.data = self._build_data()

    @staticmethod
    def _generate_machine_id() -> str:
        return "".join(random.choices(string.ascii_letters + string.digits, k=24))

    def _build_headers(self) -> dict[str, str]:
        headers = self.BASE_HEADERS.copy()
        headers.update(
            {
                "x-fb-request-analytics-tags": '{"network_tags":{"product":"350685531728","retry_attempt":"0"},"application_tags":"unknown"}',
                "user-agent": "Dalvik/2.1.0 (Linux; U; Android 9; 23113RKC6C Build/PQ3A.190705.08211809) [FBAN/FB4A;FBAV/417.0.0.33.65;FBPN/com.facebook.katana;FBLC/vi_VN;FBBV/480086274;FBCR/MobiFone;FBMF/Redmi;FBBD/Redmi;FBDV/23113RKC6C;FBSV/9;FBCA/x86:armeabi-v7a;FBDM/{density=1.5,width=1280,height=720};FB_FW/1;FBRV/0;]",
            }
        )
        return headers

    def _build_data(self) -> dict[str, str]:
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

    def _convert_token(self, access_token: str) -> dict[str, Any] | None:
        app_id = FacebookAppTokens.get_app_id(self.target_app)
        if not app_id:
            return None

        response = requests.post(
            "https://api.facebook.com/method/auth.getSessionforApp",
            data={
                "access_token": access_token,
                "format": "json",
                "new_app_id": app_id,
                "generate_session_cookies": "1",
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()

        token = payload.get("access_token")
        if not token:
            return None

        cookies_dict: dict[str, str] = {}
        cookies_string_parts = []
        for cookie in payload.get("session_cookies", []):
            name = cookie.get("name")
            value = cookie.get("value")
            if not name or value is None:
                continue
            cookies_dict[name] = value
            cookies_string_parts.append(f"{name}={value}")

        return {
            "target_app": self.target_app,
            "token_prefix": FacebookAppTokens.extract_token_prefix(token),
            "access_token": token,
            "cookies": {
                "dict": cookies_dict,
                "string": "; ".join(cookies_string_parts),
            },
        }

    def _parse_success_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        original_token = payload.get("access_token")
        if not original_token:
            return {"success": False, "error": "facebook response missing access_token"}

        original = {
            "token_prefix": FacebookAppTokens.extract_token_prefix(original_token),
            "access_token": original_token,
        }

        converted = self._convert_token(original_token)
        return {
            "success": True,
            "original_token": original,
            "converted_token": converted,
        }

    def _handle_2fa(self, error_data: dict[str, Any]) -> dict[str, Any]:
        if not self.twofa_secret:
            return {"success": False, "error": "2FA is required but twofa_secret was not provided"}

        twofactor_code = pyotp.TOTP(self.twofa_secret).now()
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
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()

        if "access_token" in payload:
            return self._parse_success_response(payload)

        error = payload.get("error", {})
        return {
            "success": False,
            "error": error.get("message", "unknown 2fa error"),
            "error_user_msg": error.get("error_user_msg"),
        }

    def login(self) -> dict[str, Any]:
        response = self.session.post(
            self.API_URL,
            headers=self.headers,
            data=self.data,
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()

        if "access_token" in payload:
            return self._parse_success_response(payload)

        error = payload.get("error", {})
        error_data = error.get("error_data", {})
        if isinstance(error_data, dict) and "login_first_factor" in error_data and "uid" in error_data:
            return self._handle_2fa(error_data)

        return {
            "success": False,
            "error": error.get("message", "unknown response format"),
            "error_user_msg": error.get("error_user_msg"),
        }


class TokenRequest(BaseModel):
    identifier: str = Field(..., description="Facebook UID / email / phone")
    password: str = Field(..., description="Raw password or #PWD_FB4A encrypted value")
    twofa: str | None = Field(default=None, description="TOTP secret")
    datr: str | None = Field(default=None, description="Use as machine_id")
    target_app: str = Field(default="FB_LITE", description="Token app target")
    timeout_seconds: int = Field(default=30, ge=5, le=120)


app = FastAPI(title="token-facebook-lite", version="1.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"ok": "true"}


@app.post("/token")
def create_token(payload: TokenRequest) -> dict[str, Any]:
    try:
        login = FacebookLogin(
            identifier=payload.identifier.strip(),
            password=payload.password,
            twofa_secret=payload.twofa or "",
            machine_id=(payload.datr.strip() if payload.datr else None),
            target_app=payload.target_app.strip().upper(),
            timeout=payload.timeout_seconds,
        )
        result = login.login()
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result)
        return result
    except HTTPException:
        raise
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail={"success": False, "error": f"network_error: {exc}"})
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"success": False, "error": str(exc)})
