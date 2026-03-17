import os

from flask import Flask, jsonify, request

from core import run_comment_token, run_proxy_check


app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS, GET"
    return response


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "token", "version": 2})


@app.route("/api/comment-token", methods=["POST", "OPTIONS"])
def comment_token():
    if request.method == "OPTIONS":
        return ("", 204)

    result, status = run_comment_token(request.get_json(silent=True) or {})
    return jsonify(result), status


@app.route("/api/proxy-check", methods=["POST", "OPTIONS"])
def proxy_check():
    if request.method == "OPTIONS":
        return ("", 204)

    result, status = run_proxy_check(request.get_json(silent=True) or {})
    return jsonify(result), status


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "80")))
