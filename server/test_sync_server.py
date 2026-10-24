import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from sync_server import Store, empty, make_server, merge, schema, validate


def fixture():
    conn = schema()
    conn.execute("INSERT INTO notebooks(id,name,order_key) VALUES('n','Notebook',1)")
    conn.execute("INSERT INTO sections(id,notebook_id,name,order_key) VALUES('s','n','Section',1)")
    conn.execute("INSERT INTO pages(id,section_id,title,plain_text,content_json,order_key) VALUES('p','s','Title','Original','{\"type\":\"doc\",\"content\":[]}',1)")
    conn.row_factory = sqlite3.Row
    snapshot = empty()
    for table in snapshot:
        for raw in conn.execute(f'SELECT * FROM {table}'):
            row = dict(raw)
            row.pop('last_opened_at', None)
            snapshot[table][row['id']] = row
    conn.close()
    return snapshot


def edit(snapshot, text):
    snapshot['pages']['p']['plain_text'] = text
    snapshot['pages']['p']['content_json'] = json.dumps({'type': 'doc', 'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': text}]}]})
    return snapshot


class MergeTests(unittest.TestCase):
    def test_first_sync_unions_devices(self):
        a = fixture()
        b = empty()
        b['notebooks']['phone'] = dict(a['notebooks']['n'], id='phone', name='Phone')
        result, _ = merge(empty(), a, b)
        self.assertIn('phone', result['notebooks'])
        self.assertEqual(result['pages'], a['pages'])

    def test_phone_downloads_then_uploads_pc_downloads(self):
        base = fixture()
        pc = edit(copy.deepcopy(base), 'PC text')
        cloud, _ = merge(base, pc, base)
        phone, _ = merge(base, base, cloud)
        edit(phone, 'Phone text')
        cloud2, _ = merge(cloud, phone, cloud)
        downloaded, _ = merge(cloud, cloud, cloud2)
        self.assertEqual(downloaded['pages']['p']['plain_text'], 'Phone text')

    def test_independent_fields_merge(self):
        base = fixture()
        pc, phone = copy.deepcopy(base), copy.deepcopy(base)
        pc['pages']['p']['title'] = 'PC title'
        edit(phone, 'Phone body')
        result, conflicts = merge(base, phone, pc)
        self.assertEqual(result['pages']['p']['title'], 'PC title')
        self.assertEqual(result['pages']['p']['plain_text'], 'Phone body')
        self.assertFalse(conflicts)

    def test_concurrent_body_keeps_both_versions(self):
        base = fixture()
        result, conflicts = merge(base, edit(copy.deepcopy(base), 'phone'), edit(copy.deepcopy(base), 'pc'))
        self.assertEqual(result['pages']['p']['plain_text'], 'phone')
        self.assertEqual({r['plain_text'] for r in result['page_revisions'].values()}, {'phone', 'pc'})
        self.assertEqual(len(conflicts), 1)

    def test_lost_response_retry_does_not_duplicate_history(self):
        base = fixture()
        local = edit(copy.deepcopy(base), 'phone')
        result, _ = merge(base, local, edit(copy.deepcopy(base), 'pc'))
        repeated, _ = merge(base, local, result)
        self.assertEqual(set(result['page_revisions']), set(repeated['page_revisions']))
        self.assertEqual(repeated['pages']['p']['plain_text'], 'phone')

    def test_offline_unchanged_device_does_not_resurrect_deleted_page(self):
        base = fixture()
        deleted = copy.deepcopy(base)
        deleted['pages'].clear()
        result, _ = merge(base, base, deleted)
        self.assertFalse(result['pages'])

    def test_hard_delete_racing_edit_keeps_edit(self):
        base = fixture()
        deleted = copy.deepcopy(base)
        deleted['pages'].clear()
        result, conflicts = merge(base, edit(copy.deepcopy(base), 'keep me'), deleted)
        self.assertEqual(result['pages']['p']['plain_text'], 'keep me')
        self.assertTrue(conflicts)

    def test_soft_delete_racing_edit_keeps_edit_active(self):
        base = fixture()
        deleted = copy.deepcopy(base)
        deleted['pages']['p']['deleted_at'] = '2026-10-12T00:00:00Z'
        result, _ = merge(base, deleted, edit(copy.deepcopy(base), 'keep me'))
        self.assertIsNone(result['pages']['p']['deleted_at'])
        self.assertEqual(result['pages']['p']['plain_text'], 'keep me')

    def test_hard_deleted_parent_restored_for_new_child(self):
        base = fixture()
        remote = empty()
        local = copy.deepcopy(base)
        local['pages']['new'] = dict(local['pages']['p'], id='new', title='New offline page')
        result, _ = merge(base, local, remote)
        self.assertIn('new', result['pages'])
        self.assertIn('s', result['sections'])
        self.assertIn('n', result['notebooks'])

    def test_duplicate_tag_names_do_not_break_sync(self):
        base = fixture()
        local, remote = copy.deepcopy(base), copy.deepcopy(base)
        for target, key in ((local, 'a'), (remote, 'b')):
            target['tags'][key] = {'id': key, 'name': 'Study', 'color': '#ffffff', 'created_at': 'now'}
            target['page_tags'][f'p|{key}'] = {'page_id': 'p', 'tag_id': key}
        result, _ = merge(base, local, remote)
        self.assertEqual(len({t['name'] for t in result['tags'].values()}), 2)
        self.assertEqual(len(result['page_tags']), 2)

    def test_conflicting_parent_moves_are_kept_visible(self):
        base = fixture()
        base['pages']['q'] = dict(base['pages']['p'], id='q')
        local, remote = copy.deepcopy(base), copy.deepcopy(base)
        local['pages']['p']['parent_page_id'] = 'q'
        remote['pages']['q']['parent_page_id'] = 'p'
        result, conflicts = merge(base, local, remote)
        validate(result)
        self.assertTrue(conflicts)
        self.assertTrue(any(row['parent_page_id'] is None for row in result['pages'].values()))

    def test_delete_edit_keeps_image_records_with_surviving_page(self):
        base = fixture()
        base['attachments']['a'] = {'id': 'a', 'page_id': 'p', 'stored_path': 'image.png', 'file_name': 'image.png', 'mime_type': 'image/png', 'size_bytes': 4, 'created_at': 'now'}
        deleted = copy.deepcopy(base)
        deleted['pages'].clear()
        deleted['attachments'].clear()
        result, _ = merge(base, deleted, edit(copy.deepcopy(base), 'edited on phone'))
        self.assertIn('a', result['attachments'])

    def test_rejects_broken_links_and_cycles(self):
        data = fixture()
        data['pages']['p']['section_id'] = 'missing'
        with self.assertRaises(ValueError): validate(data)
        data = fixture()
        data['pages']['p']['parent_page_id'] = 'p'
        with self.assertRaises(ValueError): validate(data)

    def test_rejects_attachment_path_traversal(self):
        data = fixture()
        data['attachments']['a'] = {'id': 'a', 'page_id': 'p', 'stored_path': '../outside', 'file_name': 'x', 'mime_type': 'image/png', 'size_bytes': 1, 'created_at': 'now'}
        with self.assertRaises(ValueError): validate(data)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.server = make_server(self.store, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, payload=None, token=None, method=None, raw=None):
        headers = {'Content-Type': 'application/json'}
        if token: headers['Authorization'] = 'Bearer ' + token
        data = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
        with urlopen(Request(self.url + path, data=data, headers=headers, method=method), timeout=10) as response:
            body = response.read()
            return body if raw is not None or '/files/' in path else json.loads(body)

    def signup(self, email='me@example.com'):
        return self.request('/v1/signup', {'email': email, 'password': 'correct horse battery staple'})

    def test_account_isolation_password_and_logout(self):
        first = self.signup()
        second = self.signup('other@example.com')
        cloud = self.request('/v1/sync', {'protocol': 1, 'baseline': empty(), 'snapshot': fixture()}, first['token'])
        other = self.request('/v1/sync', {'protocol': 1, 'baseline': empty(), 'snapshot': empty()}, second['token'])
        self.assertTrue(cloud['snapshot']['pages'])
        self.assertFalse(other['snapshot']['pages'])
        with self.assertRaises(HTTPError) as failure:
            self.request('/v1/login', {'email': 'me@example.com', 'password': 'wrong password value'})
        self.assertEqual(failure.exception.code, 401)
        self.request('/v1/logout', {}, first['token'])
        with self.assertRaises(HTTPError) as failure:
            self.request('/v1/sync', {}, first['token'])
        self.assertEqual(failure.exception.code, 401)
        self.assertEqual(self.store.authenticate(second['token']), second['userId'])
        with self.store.connect() as conn:
            stored = conn.execute('SELECT password_hash FROM users').fetchone()[0]
            self.assertNotIn('correct', stored)

    def test_attachment_transport_and_isolation(self):
        account, other = self.signup(), self.signup('second@example.com')
        token = account['token']
        self.request('/v1/files/image.png', token=token, method='PUT', raw=b'PNG bytes')
        self.assertEqual(self.request('/v1/files/image.png', token=token), b'PNG bytes')
        with self.assertRaises(HTTPError) as failure:
            self.request('/v1/files/image.png', token=other['token'])
        self.assertEqual(failure.exception.code, 404)
        with self.assertRaises(HTTPError) as failure:
            self.request('/v1/files/image.png', token=token, method='PUT', raw=b'different')
        self.assertEqual(failure.exception.code, 409)
        self.assertEqual(self.request('/v1/files/image.png', token=token), b'PNG bytes')

    def test_missing_attachment_prevents_workspace_commit(self):
        account = self.signup()
        snapshot = fixture()
        snapshot['attachments']['a'] = {'id': 'a', 'page_id': 'p', 'stored_path': 'file.png', 'file_name': 'x', 'mime_type': 'image/png', 'size_bytes': 4, 'created_at': 'now'}
        with self.assertRaises(HTTPError) as failure:
            self.request('/v1/sync', {'protocol': 1, 'baseline': empty(), 'snapshot': snapshot}, account['token'])
        self.assertEqual(failure.exception.code, 409)
        cloud = self.request('/v1/sync', {'protocol': 1, 'baseline': empty(), 'snapshot': empty()}, account['token'])
        self.assertFalse(cloud['snapshot']['pages'])
        self.request('/v1/files/file.png', token=account['token'], method='PUT', raw=b'data')
        synced = self.request('/v1/sync', {'protocol': 1, 'baseline': empty(), 'snapshot': snapshot}, account['token'])
        self.assertTrue(synced['snapshot']['attachments'])

    def test_restart_preserves_accounts_and_notes(self):
        account = self.signup()
        self.request('/v1/sync', {'protocol': 1, 'baseline': empty(), 'snapshot': fixture()}, account['token'])
        restarted = Store(self.temp.name)
        self.assertEqual(restarted.authenticate(account['token']), account['userId'])
        synced = restarted.sync(account['userId'], {'protocol': 1, 'baseline': empty(), 'snapshot': empty()})
        self.assertIn('p', synced['snapshot']['pages'])


if __name__ == '__main__':
    unittest.main()
