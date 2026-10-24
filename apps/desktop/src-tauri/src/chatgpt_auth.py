"""Official Sign in with ChatGPT for a locally hosted open-source LeNota desktop app.

Implements OpenAI's public OAuth dynamic-client + PKCE + OIDC validation and
store=false, stream=true Responses contract.  No ChatGPT cookies or private APIs.
Requires only Python 3 stdlib. Credentials never enter the renderer/IPC.
Docs: https://developers.openai.com/siwc/token-sharing-open-source
"""
from __future__ import annotations

import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser

AUTH = 'https://auth.openai.com'
RESOURCE = 'https://api.openai.com/v1'
SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
SESSION = Path(__file__).with_name('.chatgpt-session.json')
HOST = Path(__file__).with_name('.chatgpt-host-id')


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


def _decode_b64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def _json_request(url: str, *, form=None, token=None, method=None, timeout=15):
    headers = {'Accept': 'application/json'}
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    # HTTP redirect default is irrelevant for token requests, but must not leak Bearer.
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(2_000_000))


def _save(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + secrets.token_hex(6) + '.tmp')
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(json.dumps(value, ensure_ascii=False))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _load():
    try:
        value = json.loads(SESSION.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) and 'chatgpt.tokens.use.direct' in value.get('scopes', []) else None
    except (OSError, ValueError, TypeError):
        return None


def status():
    value = _load()
    return {'connected': bool(value), 'email': str(value.get('email') or '')[:200] if value else ''}


def _host_id():
    try:
        value = json.loads(HOST.read_text())
        if value.startswith('urn:uuid:') and uuid.UUID(value[9:]).version == 4:
            return value
    except (OSError, ValueError):
        pass
    value = 'urn:uuid:' + str(uuid.uuid4())
    _save(HOST, value)
    return value


def _validate_id_token(token: str, client_id: str, nonce: str, previous_subject: str | None = None) -> dict:
    """Verify RS256 JWT against OpenAI's OIDC-discovered JWKS using stdlib RSA.

    PKCS#1 v1.5 DigestInfo verification is deterministic and does not need pip.
    Never accept unsigned or symmetric JWTs.
    """
    header_b64, payload_b64, sig_b64 = token.split('.')
    header = json.loads(_decode_b64(header_b64))
    claims = json.loads(_decode_b64(payload_b64))
    if header.get('alg') != 'RS256' or not isinstance(header.get('kid'), str):
        raise ValueError('ChatGPT identity token uses an unsupported signature algorithm.')
    metadata = _json_request(AUTH + '/.well-known/openid-configuration')
    if metadata.get('issuer') != AUTH or not str(metadata.get('jwks_uri', '')).startswith(AUTH + '/'):
        raise ValueError('Unexpected ChatGPT identity issuer or key source.')
    keys = _json_request(metadata['jwks_uri']).get('keys', [])
    key = next((item for item in keys if item.get('kid') == header['kid'] and item.get('kty') == 'RSA'
                and item.get('use', 'sig') == 'sig' and item.get('alg', 'RS256') == 'RS256'), None)
    if not key:
        raise ValueError('ChatGPT identity signing key was not found.')
    modulus = int.from_bytes(_decode_b64(key['n']), 'big')
    exponent = int.from_bytes(_decode_b64(key['e']), 'big')
    signature = _decode_b64(sig_b64)
    size = (modulus.bit_length() + 7) // 8
    if size < 256 or len(signature) != size or not (3 <= exponent <= 65537 and exponent % 2):
        raise ValueError('Invalid ChatGPT identity signature key.')
    em = pow(int.from_bytes(signature, 'big'), exponent, modulus).to_bytes(size, 'big')
    digest_info = bytes.fromhex('3031300d060960864801650304020105000420') + hashlib.sha256((header_b64 + '.' + payload_b64).encode('ascii')).digest()
    padding_len = size - len(digest_info) - 3
    expected = b'\x00\x01' + b'\xff' * padding_len + b'\x00' + digest_info
    if padding_len < 8 or not hmac.compare_digest(em, expected):
        raise ValueError('ChatGPT identity token signature verification failed.')
    now = time.time()
    aud = claims.get('aud')
    if (claims.get('iss') != AUTH or not ((aud == client_id) or (isinstance(aud, list) and client_id in aud))
            or (isinstance(aud, list) and len(aud) > 1 and claims.get('azp') != client_id)
            or not isinstance(claims.get('exp'), (float, int)) or claims['exp'] <= now
            or not isinstance(claims.get('iat'), (float, int)) or claims['iat'] > now + 60
            or claims.get('nonce') != nonce or not isinstance(claims.get('sub'), str) or not claims['sub']):
        raise ValueError('ChatGPT identity token claims did not validate.')
    if previous_subject and claims['sub'] != previous_subject:
        raise ValueError('The signed-in ChatGPT account differs from the saved account.')
    return claims


def login():
    old = _load()
    host_id = _host_id()
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = _b64(hashlib.sha256(verifier.encode('ascii')).digest())
    result = {}

    class Callback(BaseHTTPRequestHandler):
        def do_GET(self):
            if urllib.parse.urlsplit(self.path).path != '/auth/callback':
                self.send_error(404)
                return
            params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if params.get('state', [''])[0] != state:
                self.send_error(400, 'Invalid sign-in state')
                return
            result.update({key: vals[0] for key, vals in params.items() if vals})
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(b'<html><body><h2>ChatGPT authorization returned to LeNota.</h2><p>You can close this tab and return to the app.</p></body></html>')

        def log_message(self, *_):
            pass  # Never log OAuth code, state, or tokens.

    with HTTPServer(('127.0.0.1', 0), Callback) as server:
        server.timeout = 5
        redirect = f'http://127.0.0.1:{server.server_port}/auth/callback'
        client = old['client_id'] if old else 'dynamic_agent_client'
        args = {
            'client_id': client, 'ext_agent_host_id': host_id, 'response_type': 'code',
            'redirect_uri': redirect, 'scope': SCOPES, 'resource': RESOURCE,
            'state': state, 'nonce': nonce, 'code_challenge_method': 'S256',
            'code_challenge': challenge,
        }
        if old:
            if old.get('id_token'):
                args['id_token_hint'] = old['id_token']
        else:
            args['agent_name_hint'] = 'LeNota'
        url = AUTH + '/api/accounts/authorize?' + urllib.parse.urlencode(args)
        if not webbrowser.open(url):
            raise RuntimeError('Could not open your browser. Set your default browser and retry ChatGPT sign-in.')
        until = time.monotonic() + 175
        while time.monotonic() < until and not result:
            server.handle_request()
    if not result:
        raise TimeoutError('ChatGPT sign-in timed out. Please try again.')
    if result.get('error'):
        raise RuntimeError('ChatGPT sign-in was declined or unavailable.')
    issued_client = str(result.get('client_id') or (old or {}).get('client_id') or '')
    if not issued_client or issued_client == 'dynamic_agent_client' or (old and issued_client != client):
        raise ValueError('ChatGPT client registration was not completed or did not match.')
    if not result.get('code'):
        raise ValueError('ChatGPT did not return an authorization code.')
    response = _json_request(AUTH + '/api/accounts/oauth/token', form={
        'grant_type': 'authorization_code', 'client_id': issued_client, 'code': result['code'],
        'code_verifier': verifier, 'redirect_uri': redirect, 'resource': RESOURCE,
    })
    scopes = str(response.get('scope') or '').split()
    if not {'chatgpt.tokens.use.direct', 'resource.invoke'}.issubset(scopes):
        raise RuntimeError('ChatGPT plan usage was not authorized. Allow plan sharing on the consent screen.')
    if not response.get('access_token') or not response.get('refresh_token') or not response.get('id_token'):
        raise RuntimeError('ChatGPT sign-in did not return renewable credentials.')
    claims = _validate_id_token(response['id_token'], issued_client, nonce, (old or {}).get('subject'))
    record = {'client_id': issued_client, 'ext_agent_host_id': host_id,
              'subject': claims['sub'], 'email': claims.get('email', ''),
              'id_token': response['id_token'], 'access_token': response['access_token'],
              'refresh_token': response['refresh_token'], 'scopes': scopes,
              'saved_at': time.time(), 'expires_in': int(response.get('expires_in') or 3600)}
    _save(SESSION, record)
    return status()


def access_token():
    record = _load()
    if not record:
        raise RuntimeError('ChatGPT is not connected.')
    if time.time() < record.get('saved_at', 0) + record.get('expires_in', 3600) - 120:
        return record['access_token']
    response = _json_request(AUTH + '/api/accounts/oauth/token', form={
        'grant_type': 'refresh_token', 'client_id': record['client_id'],
        'refresh_token': record['refresh_token'], 'resource': RESOURCE,
    })
    scopes = str(response.get('scope') or '').split()
    if 'chatgpt.tokens.use.direct' not in scopes:
        raise RuntimeError('ChatGPT plan permission was revoked; sign in again.')
    record.update({'access_token': response['access_token'],
                   'refresh_token': response.get('refresh_token', record['refresh_token']),
                   'scopes': scopes, 'expires_in': int(response.get('expires_in') or 3600),
                   'saved_at': time.time()})
    _save(SESSION, record)
    return record['access_token']


def disconnect():
    record = _load()
    remote = False
    if record:
        try:
            metadata = _json_request(AUTH + '/.well-known/openid-configuration')
            endpoint = metadata.get('revocation_endpoint', '')
            if endpoint.startswith(AUTH + '/'):
                request = urllib.request.Request(endpoint, data=urllib.parse.urlencode({
                    'token': record['refresh_token'], 'token_type_hint': 'refresh_token',
                    'client_id': record['client_id'],
                }).encode(), headers={'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
                with urllib.request.urlopen(request, timeout=8) as response:
                    remote = response.status == 200
        except (OSError, KeyError, ValueError, urllib.error.HTTPError):
            pass
    SESSION.unlink(missing_ok=True)
    return {'connected': False, 'remoteRevoked': remote}


if __name__ == '__main__':
    try:
        action = sys.argv[1] if len(sys.argv) > 1 else '--status'
        value = login() if action == '--login' else disconnect() if action == '--disconnect' else status()
        print('LNJSON:' + json.dumps(value))
    except Exception as exc:
        print('LNJSON:' + json.dumps({'error': str(exc)[:500]}))
        sys.exit(1)
