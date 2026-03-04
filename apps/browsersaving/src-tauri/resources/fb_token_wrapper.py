#!/usr/bin/env python3
"""
FB Token Wrapper for BrowserSaving App
รับข้อมูลผ่าน stdin JSON แล้วเรียกใช้งาน to.py logic
"""

import sys
import json
import os

# Add current directory to path to import modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def main():
    try:
        # Read JSON input from stdin
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({
                "success": False,
                "error": "No input data"
            }))
            sys.exit(1)
        
        params = json.loads(input_data)
        uid = params.get('uid', '')
        password = params.get('password', '')
        totp_secret = params.get('totp_secret', '')
        
        if not uid or not password:
            print(json.dumps({
                "success": False,
                "error": "Missing UID or password"
            }))
            sys.exit(1)
        
        # Set environment variables for to.py to use
        os.environ['FB_UID'] = uid
        os.environ['FB_PASSWORD'] = password
        os.environ['FB_TOTP'] = totp_secret
        
        # Execute to.py and capture output
        # We'll modify to.py to check for env vars first
        exec(open(os.path.join(os.path.dirname(__file__), 'to.py')).read(), {
            '__name__': '__main__',
            '__file__': os.path.join(os.path.dirname(__file__), 'to.py')
        })
        
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e)
        }))
        sys.exit(1)

if __name__ == "__main__":
    main()
