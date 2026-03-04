#!/usr/bin/env python3
"""
Facebook Token API - With Progress Steps for BrowserSaving
Prints JSON progress lines to stdout
"""

import sys
import json
import os
import random
import string
import time
import requests
import uuid
import pyotp
import base64
import io
import struct
from Crypto.Cipher import AES, PKCS1_v1_5
from Crypto.PublicKey import RSA
from Crypto.Random import get_random_bytes


def print_progress(step, message, status="active"):
    """Print progress as JSON line"""
    print(json.dumps({
        "type": "progress",
        "step": step,
        "message": message,
        "status": status
    }), flush=True)


def print_result(success, token=None, token_type=None, error=None, cookies=None):
    """Print final result"""
    print(json.dumps({
        "type": "result",
        "success": success,
        "token": token,
        "token_type": token_type,
        "error": error,
        "cookies": cookies
    }), flush=True)


def load_datr_from_local_profile(uid_value):
    """
    Try to reuse machine_id (datr) from BrowserSaving profile cookies.
    This improves Facebook login success for accounts that require known device signals.
    """
    if not uid_value:
        return None

    base_dir = os.path.expanduser("~/Library/Caches/BrowserSaving/profiles")
    if not os.path.isdir(base_dir):
        return None

    try:
        for profile_id in os.listdir(base_dir):
            cookie_file = os.path.join(base_dir, profile_id, "cookies.json")
            if not os.path.isfile(cookie_file):
                continue

            try:
                with open(cookie_file, "r", encoding="utf-8") as f:
                    cookies = json.load(f)
            except Exception:
                continue

            if not isinstance(cookies, list):
                continue

            c_user = None
            datr = None
            for cookie in cookies:
                if not isinstance(cookie, dict):
                    continue
                name = cookie.get("name")
                value = cookie.get("value")
                if name == "c_user":
                    c_user = value
                elif name == "datr":
                    datr = value

            if str(c_user or "").strip() == str(uid_value).strip() and datr:
                return str(datr).strip()
    except Exception:
        return None

    return None


class FacebookPasswordEncryptor:
    @staticmethod
    def get_public_key():
        url = 'https://b-graph.facebook.com/pwd_key_fetch'
        params = {
            'version': '2',
            'flow': 'CONTROLLER_INITIALIZATION',
            'method': 'GET',
            'fb_api_req_friendly_name': 'pwdKeyFetch',
            'fb_api_caller_class': 'com.facebook.auth.login.AuthOperations',
            'access_token': '438142079694454|fc0a7caa49b192f64f6f5a6d9643bb28'
        }
        response = requests.post(url, params=params).json()
        return response.get('public_key'), str(response.get('key_id', '25'))

    @staticmethod
    def encrypt(password, public_key=None, key_id="25"):
        if public_key is None:
            public_key, key_id = FacebookPasswordEncryptor.get_public_key()

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
        "x-fb-server-cluster": "True"
    }
    
    def __init__(self, uid_phone_mail, password, twwwoo2fa="", machine_id=None):
        self.uid_phone_mail = uid_phone_mail
        self.twwwoo2fa = twwwoo2fa
        
        print_progress(1, "Encrypting password...", "active")
        if password.startswith("#PWD_FB4A"):
            self.password = password
        else:
            self.password = FacebookPasswordEncryptor.encrypt(password)
        print_progress(1, "Password encrypted", "done")
        
        self.session = requests.Session()
        self.device_id = str(uuid.uuid4())
        self.adid = str(uuid.uuid4())
        self.secure_family_device_id = str(uuid.uuid4())
        self.machine_id = (machine_id or "").strip() or load_datr_from_local_profile(self.uid_phone_mail) or ''.join(random.choices(string.ascii_letters + string.digits, k=24))
        self.jazoest = ''.join(random.choices(string.digits, k=5))
        self.sim_serial = ''.join(random.choices(string.digits, k=20))
        
        self.headers = self._build_headers()
        self.data = self._build_data()
    
    def _build_headers(self):
        headers = self.BASE_HEADERS.copy()
        headers.update({
            "x-fb-request-analytics-tags": '{"network_tags":{"product":"350685531728","retry_attempt":"0"},"application_tags":"unknown"}',
            "user-agent": "Dalvik/2.1.0 (Linux; U; Android 9; 23113RKC6C Build/PQ3A.190705.08211809) [FBAN/FB4A;FBAV/417.0.0.33.65;FBPN/com.facebook.katana;FBLC/vi_VN;FBBV/480086274;FBCR/MobiFone;FBMF/Redmi;FBBD/Redmi;FBDV/23113RKC6C;FBSV/9;FBCA/x86:armeabi-v7a;FBDM/{density=1.5,width=1280,height=720};FB_FW/1;FBRV/0;]"
        })
        return headers
    
    def _build_data(self):
        return {
            "format": "json",
            "email": self.uid_phone_mail,
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
            "account_switcher_uids": f'["{self.uid_phone_mail}"]',
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
            "sig": self.SIG
        }
    
    def _convert_token(self, access_token):
        print_progress(4, "Converting to FB_LITE token...", "active")
        try:
            response = requests.post(
                'https://api.facebook.com/method/auth.getSessionforApp',
                data={
                    'access_token': access_token,
                    'format': 'json',
                    'new_app_id': '275254692598279',  # FB_LITE
                    'generate_session_cookies': '1'
                }
            )
            result = response.json()
            
            if 'access_token' in result:
                print_progress(4, "Token converted to FB_LITE", "done")
                return result['access_token'], result.get('session_cookies', [])
            print_progress(4, "Token conversion failed, using original", "done")
            return None, []
        except Exception as e:
            print_progress(4, f"Token conversion error: {e}", "done")
            return None, []
    
    def _handle_2fa(self, error_data):
        if not self.twwwoo2fa:
            return {'success': False, 'error': '2FA required but not provided'}
        
        print_progress(3, "2FA required, generating code...", "active")
        try:
            twofactor_code = pyotp.TOTP(self.twwwoo2fa.replace(" ", "")).now()
            
            data_2fa = {
                'locale': 'vi_VN',
                'format': 'json',
                'email': self.uid_phone_mail,
                'device_id': self.device_id,
                'access_token': self.ACCESS_TOKEN,
                'generate_session_cookies': 'true',
                'generate_machine_id': '1',
                'twofactor_code': twofactor_code,
                'credentials_type': 'two_factor',
                'error_detail_type': 'button_with_disabled',
                'first_factor': error_data['login_first_factor'],
                'password': self.password,
                'userid': error_data['uid'],
                'machine_id': error_data['login_first_factor']
            }
            
            print_progress(3, "Submitting 2FA code...", "active")
            response = self.session.post(self.API_URL, data=data_2fa, headers=self.headers)
            response_json = response.json()
            
            if 'access_token' in response_json:
                print_progress(3, "2FA passed", "done")
                return {'success': True, 'access_token': response_json['access_token'], 'session_cookies': response_json.get('session_cookies', [])}
            elif 'error' in response_json:
                return {'success': False, 'error': response_json['error'].get('message', '2FA failed')}
            
        except Exception as e:
            return {'success': False, 'error': f'2FA error: {str(e)}'}
    
    def login(self):
        print_progress(2, "Sending login request to Facebook...", "active")
        
        try:
            response = self.session.post(self.API_URL, headers=self.headers, data=self.data)
            response_json = response.json()
            
            if 'access_token' in response_json:
                print_progress(2, "Login successful", "done")
                original_token = response_json['access_token']
                
                # Convert token
                lite_token, cookies = self._convert_token(original_token)
                
                if lite_token:
                    print_result(
                        success=True,
                        token=lite_token,
                        token_type="FB_LITE (EAAD6V7)",
                        cookies=cookies
                    )
                else:
                    print_result(
                        success=True,
                        token=original_token,
                        token_type="FB Android (EAAAAU)",
                        cookies=response_json.get('session_cookies', [])
                    )
                return
            
            if 'error' in response_json:
                error_data = response_json.get('error', {}).get('error_data', {})
                
                if 'login_first_factor' in error_data and 'uid' in error_data:
                    result = self._handle_2fa(error_data)
                    if result['success']:
                        lite_token, cookies = self._convert_token(result['access_token'])
                        if lite_token:
                            print_result(
                                success=True,
                                token=lite_token,
                                token_type="FB_LITE (EAAD6V7)",
                                cookies=cookies
                            )
                        else:
                            print_result(
                                success=True,
                                token=result['access_token'],
                                token_type="FB Android (EAAAAU)",
                                cookies=result.get('session_cookies', [])
                            )
                    else:
                        print_result(success=False, error=result.get('error'))
                    return
                
                print_result(
                    success=False,
                    error=response_json['error'].get('message', 'Unknown error')
                )
                return
            
            print_result(success=False, error='Unknown response format')
            
        except Exception as e:
            print_result(success=False, error=str(e))


def main():
    try:
        input_data = sys.stdin.read()
        if not input_data:
            print_result(success=False, error='No input data')
            return
        
        params = json.loads(input_data)
        uid = params.get('uid', '')
        password = params.get('password', '')
        totp_secret = params.get('totp_secret', '')
        machine_id = params.get('machine_id', '') or params.get('datr', '')
        
        if not uid or not password:
            print_result(success=False, error='Missing uid or password')
            return
        
        print_progress(0, "Initializing...", "done")
        
        fb_login = FacebookLogin(
            uid_phone_mail=uid,
            password=password,
            twwwoo2fa=totp_secret,
            machine_id=machine_id
        )
        
        fb_login.login()
        
    except Exception as e:
        print_result(success=False, error=str(e))


if __name__ == "__main__":
    main()
