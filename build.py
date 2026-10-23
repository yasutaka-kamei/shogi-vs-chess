#!/usr/bin/env python3
"""Build the password-locked site into docs/ (the GitHub Pages source).

Usage:
    SITE_PASSWORD=xxxx python3 build.py
    python3 build.py --password xxxx

The app (index.html + style.css + src/*.js) is bundled into a single HTML
document, encrypted with AES-256-CBC + HMAC-SHA256 using a key derived from the
password (PBKDF2-HMAC-SHA256), and embedded into lock.html. The browser decrypts
it with WebCrypto after the password is entered, so nothing playable is served
unencrypted. Uses only the Python standard library plus the `openssl` CLI.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ITERATIONS = 300000


def read(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as f:
        return f.read()


def bundle():
    """Inline the stylesheet and local scripts into index.html."""
    html = read('index.html')

    def inline_css(m):
        return '<style>\n' + read(m.group(1)) + '\n</style>'

    def inline_js(m):
        src = m.group(1)
        if src.startswith('http'):
            return m.group(0)
        return '<script>\n' + read(src) + '\n</script>'

    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', inline_css, html)
    html = re.sub(r'<script src="([^"]+)"></script>', inline_js, html)
    return html


def encrypt(plaintext, password):
    salt = os.urandom(16)
    iv = os.urandom(16)
    keys = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, ITERATIONS, dklen=64)
    aes_key, mac_key = keys[:32], keys[32:]
    proc = subprocess.run(
        ['openssl', 'enc', '-aes-256-cbc', '-nosalt', '-K', aes_key.hex(), '-iv', iv.hex()],
        input=plaintext.encode('utf-8'), capture_output=True, check=True,
    )
    ct = proc.stdout
    mac = hmac.new(mac_key, iv + ct, hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode('ascii')
    return {'v': 1, 'iter': ITERATIONS, 'salt': b64(salt), 'iv': b64(iv), 'ct': b64(ct), 'mac': b64(mac)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--password', default=os.environ.get('SITE_PASSWORD'))
    ap.add_argument('--out', default='docs')
    args = ap.parse_args()
    if not args.password:
        sys.exit('password required: set SITE_PASSWORD or pass --password')

    payload = encrypt(bundle(), args.password)
    lock = read('lock.html').replace('__PAYLOAD__', json.dumps(payload))
    out_dir = os.path.join(ROOT, args.out)
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, 'index.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(lock)
    print('wrote', os.path.relpath(out, ROOT), '(%d bytes)' % os.path.getsize(out))


if __name__ == '__main__':
    main()
