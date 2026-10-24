"""Test-only Supabase API simulator. Not a deployable backend.
Real SQL/RLS is independently tested by supabase/tests/database.mjs.
"""
import json
from pathlib import Path
import secrets
import sys
import time
from sync_server import Store, make_server, Handler, HttpError, empty, validate, dumps

class MockStore(Store):
    def __init__(self, directory):
        super().__init__(directory)
        self.refresh_tokens = {}
        self.stats = {'pushes':0,'unchanged_pulls':0,'file_downloads':0,'refreshes':0,'last_cas_conflict':False}
        self.force_race = False

    def session(self, account):
        refresh = secrets.token_urlsafe(32)
        self.refresh_tokens[refresh] = (account['userId'],account['email'],account['token'])
        return {'access_token':account['token'],'refresh_token':refresh,'expires_at':int(time.time())+3600,'expires_in':3600,'user':{'id':account['userId'],'email':account['email']}}

class MockHandler(Handler):
    def handle_request(self):
        try:
            path=self.path.split('?',1)[0];store=self.server.store
            if path=='/test/stats':return self.reply(200,store.stats)
            if path=='/test/race':store.force_race=True;return self.reply(200,{'ok':True})
            if self.headers.get('apikey')!='sb_publishable_test':raise HttpError(401,'Invalid API key')
            if self.command=='POST' and path in ('/auth/v1/token','/auth/v1/signup'):
                data=json.loads(self.body(16384))
                if 'grant_type=refresh_token' in self.path:
                    saved=store.refresh_tokens.pop(data.get('refresh_token'),None)
                    if not saved:raise HttpError(400,'Invalid Refresh Token')
                    uid,email,old=saved;token=secrets.token_urlsafe(32)
                    import hashlib
                    with store.connect() as conn:
                        conn.execute('DELETE FROM sessions WHERE token_hash=?',(hashlib.sha256(old.encode()).hexdigest(),))
                        conn.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),uid,time.time()+3600))
                    store.stats['refreshes']+=1
                    return self.reply(200,store.session({'userId':uid,'email':email,'token':token}))
                return self.reply(200,store.session(store.account(data.get('email'),data.get('password'),path.endswith('signup'))))
            auth=self.headers.get('Authorization','');token=auth[7:] if auth.startswith('Bearer ') else ''
            uid=store.authenticate(token)
            if path=='/auth/v1/logout':
                import hashlib
                with store.connect() as conn:conn.execute('DELETE FROM sessions WHERE token_hash=?',(hashlib.sha256(token.encode()).hexdigest(),))
                for key,value in list(store.refresh_tokens.items()):
                    if value[2]==token:del store.refresh_tokens[key]
                return self.reply(200,{'ok':True})
            if self.command=='POST' and path.startswith('/rest/v1/rpc/'):
                data=json.loads(self.body(64*1024*1024))
                with store.lock,store.connect() as conn:
                    raw,version=conn.execute('SELECT snapshot,version FROM workspaces WHERE user_id=?',(uid,)).fetchone()
                    if path.endswith('lenota_pull'):
                        unchanged=version==data.get('p_known_version')
                        if unchanged:store.stats['unchanged_pulls']+=1
                        return self.reply(200,{'version':version,'snapshot':None if unchanged else json.loads(raw)})
                    if path.endswith('lenota_push'):
                        if store.force_race:
                            store.force_race=False;version+=1
                            raced=json.loads(raw)
                            if raced['pages']:
                                row=next(iter(raced['pages'].values()));row['title']='A concurrent cloud title'
                            conn.execute('UPDATE workspaces SET snapshot=?,version=? WHERE user_id=?',(dumps(raced),version,uid))
                            store.stats['last_cas_conflict']=True
                        if version!=data['p_expected_version']:return self.reply(200,{'committed':False,'version':version})
                        snap=data['p_snapshot'];validate(snap)
                        for aid,row in snap['attachments'].items():
                            target=store.directory/'objects'/uid/aid/row['stored_path']
                            if not target.exists() or target.stat().st_size!=row['size_bytes']:raise HttpError(400,'An attachment has not finished uploading')
                        if snap!=json.loads(raw):version+=1;conn.execute('UPDATE workspaces SET snapshot=?,version=? WHERE user_id=?',(dumps(snap),version,uid))
                        store.stats['pushes']+=1
                        return self.reply(200,{'committed':True,'version':version})
            prefix='/storage/v1/object/'
            if path.startswith(prefix):
                rest=path[len(prefix):]
                if rest.startswith('authenticated/'):rest=rest[len('authenticated/'):]
                parts=rest.split('/')
                if len(parts)!=4 or parts[0]!='lenota-notes' or parts[1]!=uid:raise HttpError(404,'Object not found')
                if any(not part or part in ('.','..') for part in parts):raise HttpError(400,'Invalid object path')
                target=store.directory/'objects'/uid/parts[2]/parts[3]
                if self.command=='POST':
                    if target.exists():return self.reply(400,{'statusCode':'409','error':'Duplicate','message':'The resource already exists'})
                    data=self.body(50_000_000);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data);return self.reply(200,{'Key':rest})
                if self.command=='GET':
                    if not target.exists():raise HttpError(404,'Object not found')
                    store.stats['file_downloads']+=1
                    return self.reply(200,raw=target.read_bytes())
            raise HttpError(404,'Unknown mock endpoint')
        except HttpError as error:self.reply(error.status,{'msg':error.message})
        except Exception as error:self.reply(500,{'message':str(error)})

    do_GET=do_POST=handle_request

if __name__=='__main__':
    server=make_server(MockStore(sys.argv[1]),port=0);server.RequestHandlerClass=MockHandler
    print(server.server_port,flush=True);server.serve_forever()
