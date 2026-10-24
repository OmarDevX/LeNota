#!/usr/bin/env python3
"""LeNota personal sync service. Python 3.11+, standard library only.
Run behind HTTPS in production. No note contents or credentials are logged.
"""
import argparse
import copy
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone

TABLES = ('notebooks', 'section_groups', 'sections', 'pages', 'tags', 'page_tags',
          'page_revisions', 'trash_entries', 'attachments')
ROOT = Path(__file__).resolve().parents[1]
MAX_JSON = 64 * 1024 * 1024
MAX_FILE = 100_000_000
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}\Z')
SCHEMA_LOCK = threading.Lock()


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def empty():
    return {table: {} for table in TABLES}


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False)


def schema():
    conn = sqlite3.connect(':memory:')
    for path in sorted((ROOT / 'crates/app-database/migrations').glob('*.sql')):
        conn.executescript(path.read_text())
    return conn


with schema() as _conn:
    COLUMNS = {t: [row[1] for row in _conn.execute(f'PRAGMA table_info({t})')
                   if row[1] != 'last_opened_at'] for t in TABLES}


def validate(snapshot):
    if not isinstance(snapshot, dict) or set(snapshot) != set(TABLES):
        raise ValueError('Incompatible snapshot schema. Update both apps and the server.')
    conn = schema()
    try:
        conn.execute('BEGIN')
        conn.execute('PRAGMA defer_foreign_keys=ON')
        for table in TABLES:
            records = snapshot[table]
            if not isinstance(records, dict) or len(records) > 100_000:
                raise ValueError('Invalid or oversized record collection')
            names = COLUMNS[table]
            sql = f'INSERT INTO {table} ({",".join(names)}) VALUES ({",".join("?" for _ in names)})'
            for key, record in records.items():
                if not isinstance(record, dict) or set(record) != set(names):
                    raise ValueError(f'Invalid {table} columns')
                expected = f'{record["page_id"]}|{record["tag_id"]}' if table == 'page_tags' else record['id']
                if not isinstance(key, str) or key != expected or len(key) > 300:
                    raise ValueError('Invalid record ID')
                if any(not isinstance(v, (str, int, float, type(None))) or isinstance(v, bool) for v in record.values()):
                    raise ValueError('Invalid column value')
                if table == 'attachments':
                    if not isinstance(record['stored_path'], str) or not NAME.fullmatch(record['stored_path']):
                        raise ValueError('Unsafe attachment name')
                    if not isinstance(record['size_bytes'], int) or not 0 <= record['size_bytes'] <= MAX_FILE:
                        raise ValueError('Attachments are limited to 100 MB each')
                if table in ('pages', 'page_revisions'):
                    json.loads(record['content_json'])
                conn.execute(sql, [record[n] for n in names])
        if conn.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('Snapshot contains broken notebook/page links')
        # Prevent malformed hierarchy cycles, which can otherwise hide pages.
        for table, parent in (('pages', 'parent_page_id'), ('section_groups', 'parent_group_id')):
            for key, record in snapshot[table].items():
                seen = {key}
                ancestor = record[parent]
                while ancestor:
                    if ancestor in seen:
                        raise ValueError('Hierarchy contains a cycle')
                    seen.add(ancestor)
                    ancestor = snapshot[table][ancestor][parent]
        conn.commit()
    except (sqlite3.Error, KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError('Invalid workspace data or links') from error
    finally:
        conn.close()


def meaningful(record):
    return {k: v for k, v in (record or {}).items() if k not in ('updated_at', 'created_at')}


def merge(base, local, remote):
    """Three-way field merge. Page bodies are atomic; save both conflicting bodies.
    No client clocks decide winners. Only changes from the acknowledged base push.
    Repeated requests after a lost reply are idempotent.
    """
    result = copy.deepcopy(remote)
    conflicts = []
    archive = []
    for table in TABLES:
        for key in set(base[table]) | set(local[table]):
            b, l, r = base[table].get(key), local[table].get(key), remote[table].get(key)
            if l == b or l == r or (l is not None and r is not None and meaningful(l) == meaningful(r)):
                continue
            if r == b:
                if l is None:
                    result[table].pop(key, None)
                else:
                    result[table][key] = copy.deepcopy(l)
                continue
            # A physical delete racing with an edit keeps the edited record.
            if l is None or r is None:
                survivor = l if l is not None else r
                if survivor is not None:
                    result[table][key] = copy.deepcopy(survivor)
                    conflicts.append({'table': table, 'id': key, 'reason': 'delete-versus-edit; edited item kept'})
                continue
            combined = copy.deepcopy(r)
            overlap = False
            body = ('title', 'content_json', 'plain_text') if table == 'pages' else ()
            # Keep document and its search text together, but merge titles independently.
            if body:
                fields = ('content_json', 'plain_text')
                lb = tuple(l.get(f) for f in fields)
                bb = tuple((b or {}).get(f) for f in fields)
                rb = tuple(r.get(f) for f in fields)
                if lb != bb:
                    for f in fields:
                        combined[f] = l[f]
                    overlap |= rb != bb and rb != lb
            for field, value in l.items():
                if field in ('updated_at', 'content_json', 'plain_text') and table == 'pages':
                    continue
                if field == 'updated_at':
                    continue
                old = (b or {}).get(field)
                if value != old:
                    combined[field] = value
                    overlap |= r.get(field) != old and r.get(field) != value
            # Soft delete versus content/metadata edit keeps an active edited item.
            if 'deleted_at' in l and bool(l['deleted_at']) != bool(r['deleted_at']):
                active = r if l['deleted_at'] else l
                if meaningful(active) != meaningful(b):
                    combined.update(copy.deepcopy(active))
                    combined['deleted_at'] = None
                    if 'trash_batch_id' in combined:
                        combined['trash_batch_id'] = None
                    overlap = True
            if 'updated_at' in combined:
                combined['updated_at'] = now()
            result[table][key] = combined
            if overlap:
                conflicts.append({'table': table, 'id': key, 'reason': 'concurrent edits'})
                if table == 'pages':
                    archive.extend((l, r))
    # Preserve managed files/history for pages kept after a conflicting edit/delete.
    # A document or archived body can still refer to either device's image IDs.
    conflict_pages = {item['id'] for item in conflicts if item['table'] == 'pages'}
    for table in ('attachments', 'page_revisions'):
        for source in (base, remote, local):
            for key, record in source[table].items():
                if record['page_id'] in conflict_pages:
                    result[table].setdefault(key, copy.deepcopy(record))
    # Restore required ancestors when a parent deletion raced with a child creation/edit.
    sources = (local, remote, base)
    def restore(table, key):
        if not key or key in result[table]:
            return
        for source in sources:
            if key in source[table]:
                result[table][key] = copy.deepcopy(source[table][key])
                conflicts.append({'table': table, 'id': key, 'reason': 'kept parent of an edited item'})
                return
        raise ValueError('An edited item has no recoverable parent')
    for record in list(result['attachments'].values()) + list(result['page_revisions'].values()) + list(result['page_tags'].values()):
        restore('pages', record['page_id'])
        if 'tag_id' in record:
            restore('tags', record['tag_id'])
    for record in list(result['pages'].values()):
        restore('sections', record['section_id'])
        if record['parent_page_id'] not in result['pages']:
            record['parent_page_id'] = None
    for record in list(result['sections'].values()):
        restore('notebooks', record['notebook_id'])
        if record['section_group_id'] not in result['section_groups']:
            record['section_group_id'] = None
    for record in list(result['section_groups'].values()):
        restore('notebooks', record['notebook_id'])
        if record['parent_group_id'] not in result['section_groups']:
            record['parent_group_id'] = None
    # An edited active child must not disappear under a concurrently trashed parent.
    for table, parent_table, field in (('pages', 'sections', 'section_id'), ('sections', 'notebooks', 'notebook_id')):
        for key, record in result[table].items():
            if record.get('deleted_at'):
                continue
            b = base[table].get(key)
            if meaningful(record) == meaningful(b):
                continue
            parent = result[parent_table][record[field]]
            if parent.get('deleted_at'):
                parent['deleted_at'] = None
                parent['trash_batch_id'] = None
                conflicts.append({'table': parent_table, 'id': parent['id'], 'reason': 'restored parent of edited item'})
    for record in archive:
        digest = hashlib.sha256(dumps({f: record[f] for f in ('id', 'title', 'content_json', 'plain_text')}).encode()).hexdigest()
        revision_id = 'sync-' + digest
        result['page_revisions'].setdefault(revision_id, {
            'id': revision_id, 'page_id': record['id'], 'title': record['title'],
            'content_json': record['content_json'], 'plain_text': record['plain_text'], 'created_at': now(),
        })
    # Separate devices can independently create the same tag name with different IDs.
    # Keep both links and make names unique, instead of breaking SQLite's constraint.
    used = set()
    for key, record in sorted(result['tags'].items()):
        name = record['name']
        if name.lower() in used:
            name = f'{name} ({key[:8]})'
            while name.lower() in used:
                name += '+'
            record['name'] = name
        used.add(name.lower())
    for key, record in list(result['trash_entries'].items()):
        table = {'page': 'pages', 'section': 'sections', 'notebook': 'notebooks'}[record['entity_type']]
        target = result[table].get(record['entity_id'])
        if not target or not target.get('deleted_at'):
            del result['trash_entries'][key]
    # Independently valid hierarchy moves can create a cycle when combined.
    # Detach the first deterministic offending link and keep every item visible.
    for table, parent, scope in (('pages', 'parent_page_id', 'section_id'), ('section_groups', 'parent_group_id', 'notebook_id')):
        for key, record in sorted(result[table].items()):
            seen = {key}
            ancestor = record[parent]
            while ancestor:
                if ancestor in seen or result[table][ancestor][scope] != record[scope]:
                    record[parent] = None
                    conflicts.append({'table': table, 'id': key, 'reason': 'conflicting hierarchy moves; item kept at top level'})
                    break
                seen.add(ancestor)
                ancestor = result[table][ancestor][parent]
    validate(result)
    return result, conflicts


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.limits = {}
        with self.connect() as conn:
            conn.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS workspaces(user_id TEXT PRIMARY KEY,snapshot TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0);
            ''')
        try:
            os.chmod(self.directory, 0o700)
        except OSError:
            pass

    def connect(self):
        return sqlite3.connect(self.directory / 'accounts.sqlite3', timeout=30)

    def rate_limit(self, ip):
        with self.lock:
            start, count = self.limits.get(ip, (time.time(), 0))
            if time.time() - start > 60:
                start, count = time.time(), 0
            self.limits[ip] = (start, count + 1)
            if count >= 12:
                raise HttpError(429, 'Too many account attempts. Try again in a minute.')
            if len(self.limits) > 10_000:
                self.limits = {k: v for k, v in self.limits.items() if time.time() - v[0] < 60}

    def account(self, email, password, signup):
        if not isinstance(email, str) or not isinstance(password, str):
            raise HttpError(400, 'Email and password are required')
        email = email.strip().lower()
        if len(email) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            raise HttpError(400, 'Enter a valid email address')
        if not 12 <= len(password) <= 1024:
            raise HttpError(400, 'Password must contain 12–1024 characters')
        with self.lock, self.connect() as conn:
            user = conn.execute('SELECT id,salt,password_hash FROM users WHERE email=?', (email,)).fetchone()
            if signup:
                if os.getenv('LENOTA_ALLOW_SIGNUP', '1') != '1':
                    raise HttpError(403, 'Account registration is disabled on this server')
                if user:
                    raise HttpError(409, 'This email already has an account. Sign in instead.')
                salt = secrets.token_hex(16)
                digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 600_000).hex()
                uid = secrets.token_hex(16)
                conn.execute('INSERT INTO users VALUES(?,?,?,?)', (uid, email, salt, digest))
                conn.execute('INSERT INTO workspaces(user_id,snapshot) VALUES(?,?)', (uid, dumps(empty())))
            else:
                salt = user[1] if user else '0' * 32
                digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 600_000).hex()
                if not user or not hmac.compare_digest(digest, user[2]):
                    raise HttpError(401, 'Incorrect email or password')
                uid = user[0]
            token = secrets.token_urlsafe(32)
            conn.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
            conn.execute('INSERT INTO sessions VALUES(?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), uid, time.time() + 30 * 86400))
            return {'userId': uid, 'email': email, 'token': token}

    def authenticate(self, token):
        if not token or len(token) > 256:
            raise HttpError(401, 'Sign in to sync')
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.connect() as conn:
            row = conn.execute('SELECT user_id FROM sessions WHERE token_hash=? AND expires>?', (digest, time.time())).fetchone()
        if not row:
            raise HttpError(401, 'Session expired. Sign in again; your offline notes are safe.')
        return row[0]

    def blob(self, uid, name):
        if not NAME.fullmatch(name):
            raise HttpError(400, 'Invalid attachment name')
        directory = self.directory / 'attachments' / uid
        directory.mkdir(parents=True, exist_ok=True)
        return directory / name

    def sync(self, uid, payload):
        if payload.get('protocol') != 1:
            raise HttpError(400, 'Incompatible sync protocol')
        local, base = payload.get('snapshot'), payload.get('baseline')
        validate(local)
        validate(base)
        with self.lock, self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            raw, version = conn.execute('SELECT snapshot,version FROM workspaces WHERE user_id=?', (uid,)).fetchone()
            remote = json.loads(raw)
            result, conflicts = merge(base, local, remote)
            for record in result['attachments'].values():
                path = self.blob(uid, record['stored_path'])
                if not path.is_file() or path.stat().st_size != record['size_bytes']:
                    raise HttpError(409, 'An attachment has not finished uploading. Retry sync.')
            encoded = dumps(result)
            if len(encoded.encode()) > MAX_JSON // 2:
                raise HttpError(413, 'Workspace metadata exceeds the personal server limit (32 MiB)')
            if encoded != raw:
                version += 1
                conn.execute('UPDATE workspaces SET snapshot=?,version=? WHERE user_id=?', (encoded, version, uid))
            return {'snapshot': result, 'version': version, 'conflicts': conflicts}


class HttpError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    server_version = 'LeNotaSync/1'
    def log_message(self, *_):
        pass

    def reply(self, status, payload=None, raw=None):
        data = raw if raw is not None else dumps(payload or {}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/octet-stream' if raw is not None else 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def body(self, maximum):
        try:
            size = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            raise HttpError(400, 'Invalid body length')
        if not 0 <= size <= maximum:
            raise HttpError(413, 'Request exceeds server limit')
        self.connection.settimeout(60)
        data = self.rfile.read(size)
        if len(data) != size:
            raise HttpError(400, 'Incomplete request')
        return data

    def handle_request(self):
        try:
            path = self.path.split('?', 1)[0]
            store = self.server.store
            if self.command == 'GET' and path == '/health':
                return self.reply(200, {'service': 'LeNota', 'protocol': 1})
            if self.command == 'POST' and path in ('/v1/signup', '/v1/login'):
                store.rate_limit(self.client_address[0])
                payload = json.loads(self.body(16_384))
                return self.reply(200, store.account(payload.get('email'), payload.get('password'), path.endswith('signup')))
            authorization = self.headers.get('Authorization', '')
            token = authorization[7:] if authorization.startswith('Bearer ') else ''
            uid = store.authenticate(token)
            if self.command == 'POST' and path == '/v1/logout':
                with store.connect() as conn:
                    conn.execute('DELETE FROM sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))
                return self.reply(200, {'ok': True})
            if self.command == 'POST' and path == '/v1/sync':
                return self.reply(200, store.sync(uid, json.loads(self.body(MAX_JSON))))
            if path.startswith('/v1/files/'):
                name = path.removeprefix('/v1/files/')
                target = store.blob(uid, name)
                if self.command in ('GET', 'HEAD'):
                    if not target.is_file():
                        raise HttpError(404, 'Attachment not found')
                    if self.command == 'HEAD':
                        self.send_response(200)
                        self.send_header('Content-Length', str(target.stat().st_size))
                        self.send_header('Cache-Control', 'no-store')
                        self.end_headers()
                        return
                    return self.reply(200, raw=target.read_bytes())
                if self.command == 'PUT':
                    data = self.body(MAX_FILE)
                    with store.lock:
                        if target.exists():
                            if not hmac.compare_digest(hashlib.sha256(target.read_bytes()).digest(), hashlib.sha256(data).digest()):
                                raise HttpError(409, 'Attachment ID collision; existing file was preserved')
                        else:
                            quota = int(os.getenv('LENOTA_USER_QUOTA_MB', '1024')) * 1024 * 1024
                            used = sum(p.stat().st_size for p in target.parent.iterdir() if p.is_file())
                            if used + len(data) > quota:
                                raise HttpError(413, 'Account attachment quota exceeded')
                            temporary = target.with_name('.upload-' + secrets.token_hex(16))
                            try:
                                temporary.write_bytes(data)
                                os.replace(temporary, target)
                            finally:
                                temporary.unlink(missing_ok=True)
                    return self.reply(200, {'ok': True})
            raise HttpError(404, 'Unknown endpoint')
        except HttpError as error:
            self.reply(error.status, {'error': error.message})
        except (ValueError, TypeError, AttributeError, KeyError):
            self.reply(400, {'error': 'Invalid request or workspace data'})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            self.reply(500, {'error': 'Server storage error. No workspace changes were committed.'})

    do_GET = do_POST = do_PUT = do_HEAD = handle_request


def make_server(store, host='127.0.0.1', port=8787):
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.store = store
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--data', default='sync-data')
    args = parser.parse_args()
    os.umask(0o077)
    server = make_server(Store(args.data), args.host, args.port)
    print(f'LeNota sync server on {args.host}:{args.port}. Use HTTPS for remote access.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
