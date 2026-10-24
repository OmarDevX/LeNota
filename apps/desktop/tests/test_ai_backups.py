"""Provider-order and ChatGPT OAuth regression tests. All requests are mocked."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from types import SimpleNamespace
from unittest.mock import patch

SRC = Path(__file__).parents[1] / 'src-tauri/src'
spec = importlib.util.spec_from_file_location('chatgpt_auth', SRC / 'chatgpt_auth.py')
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)
spec = importlib.util.spec_from_file_location('worker', SRC / 'cloud_ai_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
REAL_OPENROUTER_CATALOG = worker._openrouter_available_models


class Response:
    def __init__(self, blocks=None, model='free/actual', finish='stop'):
        self.payload = json.dumps({'model':model, 'choices':[{'finish_reason':finish,
            'message': {'content':json.dumps({'blocks':blocks or [{'type':'paragraph','text':'Answer'}]})}}]}).encode()
    def __enter__(self): return self
    def __exit__(self,*_): pass
    def read(self,n=-1): return self.payload[:n] if n >= 0 else self.payload


class Stream:
    def __init__(self,complete=True):
        self.events = [
            {'type':'response.output_text.delta','delta':'{"blocks":[{"type":"paragraph","text":"Correct"}]}'},
            {'type': 'response.completed' if complete else 'response.incomplete'}]
    def __enter__(self): return self
    def __exit__(self,*_): pass
    def __iter__(self):
        for value in self.events:
            yield ('data: '+json.dumps(value)+'\n').encode()


class ProviderTests(unittest.TestCase):
    def setUp(self):
        worker._backup_cooldowns.clear()
        worker._cloud_model_cooldowns.clear()
        worker._chatgpt_model_cache = None
        worker._openrouter_catalog_cache = None
        catalog = [
            {'id': name, 'pricing': {'prompt': '0', 'completion': '0', 'image':'0'},
             'architecture': {'input_modalities': ['text', 'image'] if name.startswith('google/') else ['text']}}
            for name in (*worker._OPENROUTER_TEXT, *worker._OPENROUTER_VISION)
        ]
        patcher = patch.object(worker, '_openrouter_available_models', return_value=catalog)
        patcher.start(); self.addCleanup(patcher.stop)
        self.keys = {'openrouter':'sk-or-synthetic-test-key-0123456789'}
        patcher = patch.object(worker,'_backup_keys',return_value=self.keys)
        patcher.start();self.addCleanup(patcher.stop)
        patcher = patch.object(worker,'chatgpt_auth', SimpleNamespace(status=lambda:{'connected':False}))
        patcher.start();self.addCleanup(patcher.stop)

    def ask(self,api_key='AIza-synthetic',parts=None):
        return worker._gemini_generate(api_key,parts or [{'text':'page and question'}],80,8192,'Cloud Ask',worker._validate_ask_response)

    def test_chatgpt_has_priority_even_when_gemini_and_openrouter_are_configured(self):
        worker.chatgpt_auth.status = lambda:{'connected':True}
        with patch.object(worker,'_chatgpt_generate',return_value=({'blocks':[{'type':'paragraph','text':'GPT'}]},'ChatGPT Plus · gpt-6')) as gpt, \
             patch.object(worker,'_gemini_generate_remote') as gemini, patch.object(worker,'_backup_open') as router:
            value,engine=self.ask()
            self.assertEqual(value['blocks'][0]['text'],'GPT')
            self.assertTrue(engine.startswith('ChatGPT Plus'))
            gpt.assert_called_once();gemini.assert_not_called();router.assert_not_called()

    def test_chatgpt_outage_falls_back_to_gemini_before_openrouter(self):
        worker.chatgpt_auth.status = lambda:{'connected':True}
        with patch.object(worker,'_chatgpt_generate',side_effect=RuntimeError('usage limit')), \
             patch.object(worker,'_gemini_generate_remote',return_value=({'blocks':[{'type':'paragraph','text':'Gemini'}]},'Gemini Flash')) as gemini, \
             patch.object(worker,'_backup_open') as router:
            result,engine=self.ask()
            self.assertEqual(engine,'Gemini Flash')
            gemini.assert_called_once();router.assert_not_called()

    def test_both_primary_providers_fail_and_openrouter_is_last(self):
        worker.chatgpt_auth.status = lambda:{'connected':True}
        with patch.object(worker,'_chatgpt_generate',side_effect=RuntimeError('usage limit')), \
             patch.object(worker,'_gemini_generate_remote',side_effect=RuntimeError('HTTP 429')), \
             patch.object(worker,'_backup_open',return_value=Response()) as backup:
            _,engine=self.ask()
            self.assertIn('OpenRouter Free',engine)
            payload=json.loads(backup.call_args.args[0].data)
            self.assertEqual(payload['model'],'nvidia/nemotron-3-ultra-550b-a55b:free')
            self.assertEqual(payload['provider']['max_price'],{'prompt':0,'completion':0})
            self.assertNotIn('groq',backup.call_args.args[0].full_url.lower())

    def test_vision_model_gets_image_and_page_context(self):
        with patch.object(worker,'_gemini_generate_remote',side_effect=RuntimeError('no Gemini')), \
             patch.object(worker,'_backup_open',return_value=Response()) as backup:
            value,engine=self.ask(parts=[{'text':'Italy grammar'},{'inline_data':{'mime_type':'image/png','data':'cG5n'}}])
            payload=json.loads(backup.call_args.args[0].data)
            self.assertEqual(payload['model'],'google/gemma-4-31b-it:free')
            self.assertIn('Italy grammar',payload['messages'][0]['content'][0]['text'])
            self.assertEqual(payload['messages'][0]['content'][1]['image_url']['url'],'data:image/png;base64,cG5n')

    def test_free_router_tries_second_named_model_on_404(self):
        requests=[]
        def send(req,timeout):
            requests.append(json.loads(req.data))
            if len(requests) == 1:
                raise __import__('urllib.error',fromlist=['HTTPError']).HTTPError(req.full_url,404,'missing',{},io.BytesIO(b'{}'))
            return Response()
        with patch.object(worker,'_gemini_generate_remote',side_effect=RuntimeError('Gemini offline')), \
             patch.object(worker,'_backup_open',side_effect=send):
            _,engine=self.ask()
            self.assertIn('OpenRouter',engine)
            self.assertEqual([x['model'] for x in requests],list(worker._OPENROUTER_TEXT[:2]))
            self.assertTrue(all(item['model'].endswith(':free') for item in requests))
            self.assertTrue(all(item['provider']['max_price']=={'prompt':0,'completion':0} for item in requests))

    def test_network_dns_failures_fall_back_without_suppressing_next_ask(self):
        worker.chatgpt_auth.status = lambda: {'connected': True}
        dns_error = urllib.error.URLError(OSError('[Errno -3] Temporary failure in name resolution'))
        with patch.object(worker, '_chatgpt_generate', side_effect=dns_error) as gpt, \
             patch.object(worker, '_gemini_generate_remote', side_effect=TimeoutError('read operation timed out')) as gemini, \
             patch.object(worker, '_backup_open', side_effect=dns_error) as router:
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, 'Network/DNS failure'):
                    self.ask()
            self.assertEqual(gpt.call_count, 2, 'ChatGPT must be tried again immediately after DNS recovers')
            self.assertEqual(gemini.call_count, 2, 'Gemini read timeout must not block the next ask')
            self.assertEqual(router.call_count, 2, 'OpenRouter must not try a second model against broken DNS')
            self.assertNotIn('chatgpt', worker._backup_cooldowns)
            self.assertNotIn('gemini', worker._backup_cooldowns)
            self.assertNotIn('openrouter', worker._backup_cooldowns)

    def test_capacity_error_cooldown_still_prevents_spam(self):
        worker.chatgpt_auth.status = lambda: {'connected': True}
        with patch.object(worker, '_chatgpt_generate', side_effect=RuntimeError('subscription_sharing_usage_limit_exceeded')) as gpt, \
             patch.object(worker, '_gemini_generate_remote', side_effect=RuntimeError('HTTP 429 RESOURCE_EXHAUSTED')) as gemini, \
             patch.object(worker, '_backup_open', return_value=Response()):
            self.assertIn('OpenRouter', self.ask()[1])
            self.assertIn('OpenRouter', self.ask()[1])
            self.assertEqual(gpt.call_count, 1)
            self.assertEqual(gemini.call_count, 1)

    def test_transient_network_conditions_are_not_capacity_errors(self):
        for value in ('<urlopen error [Errno -3] Temporary failure in name resolution>',
                      'The read operation timed out', 'connection reset by peer'):
            self.assertFalse(worker._requires_provider_cooldown(RuntimeError(value)))
        for value in ('HTTP 429', 'usage limit', 'HTTP 401'):
            self.assertTrue(worker._requires_provider_cooldown(RuntimeError(value)))

    def test_only_gemini_still_uses_existing_worker_without_router_cooldown(self):
        self.keys.clear()
        with patch.object(worker,'_gemini_generate_remote',return_value=({'blocks':[{'type':'paragraph','text':'Gemini'}]},'gemini')) as gemini:
            for _ in range(2): self.assertEqual(self.ask()[1],'gemini')
            self.assertEqual(gemini.call_count,2)

    def test_chatgpt_sse_uses_visible_account_model_and_requires_completion(self):
        worker.chatgpt_auth = SimpleNamespace(status=lambda:{'connected':True},access_token=lambda:'fake-oauth-access',
            _json_request=lambda *args,**kwargs:{'models':[{'slug':'gpt-5.6','visibility':'list'}, {'slug':'gpt-6.1-sol','visibility':'list'}]})
        with patch.object(worker,'_backup_open',return_value=Stream()) as send:
            value,engine=worker._chatgpt_generate([{'text':'explain'}],worker._validate_ask_response,40.)
            self.assertEqual(value['blocks'][0]['text'],'Correct')
            self.assertEqual(engine,'ChatGPT Plus · gpt-6.1-sol')
            req=send.call_args.args[0]
            payload=json.loads(req.data)
            self.assertEqual(req.get_header('Authorization'),'Bearer fake-oauth-access')
            self.assertEqual(payload['model'],'gpt-6.1-sol')
            self.assertEqual((payload['store'],payload['stream']),(False,True))
            self.assertEqual(payload['input'][0]['content'][0]['type'],'input_text')
        with patch.object(worker,'_backup_open',return_value=Stream(complete=False)):
            with self.assertRaisesRegex(RuntimeError,'stream failed'):
                worker._chatgpt_generate([{'text':'explain'}],worker._validate_ask_response,40.)

    def test_incomplete_stream_is_never_written_to_notes(self):
        worker.chatgpt_auth = SimpleNamespace(status=lambda:{'connected':True},access_token=lambda:'fake',
            _json_request=lambda *a,**kw:{'models':[{'slug':'gpt-6.1-sol','visibility':'list'}]})
        class InterruptedStream:
            def __enter__(self): return self
            def __exit__(self,*_): pass
            def __iter__(self): return iter([b'data: {"type":"response.output_text.delta","delta":"partial"}\n'])
        with patch.object(worker,'_backup_open',return_value=InterruptedStream()):
            with self.assertRaisesRegex(RuntimeError,'response.completed'):
                worker._chatgpt_generate([{'text':'question'}],worker._validate_ask_response,20.)

    def test_dynamic_catalog_skips_404_stale_paid_and_image_incompatible_models(self):
        live_models = [
            {'id':'qwen/qwen3.8-27b:free','pricing':{'prompt':'0','completion':'0'},'architecture':{'input_modalities':['text']}},
            {'id':'google/gemma-4-31b-it:free','pricing':{'prompt':'0','completion':'0','image':'0'},'architecture':{'input_modalities':['text','image']}},
            {'id':'vendor/premium:free','pricing':{'prompt':'0','completion':'1'},'architecture':{'input_modalities':['text','image']}},
            {'id':'vendor/paid','pricing':{'prompt':'0','completion':'0'},'architecture':{'input_modalities':['text','image']}},
            {'id':'vendor/great-vision:free','pricing':{'prompt':'0','completion':'0','image':'0'},'architecture':{'input_modalities':['image','text']}},
        ]
        with patch.object(worker, '_openrouter_available_models', return_value=[m for m in live_models if worker._catalog_is_free(m)]):
            candidates=worker._openrouter_model_choices('synthetic',True,5.)
        self.assertEqual(candidates,('google/gemma-4-31b-it:free','vendor/great-vision:free'))
        self.assertNotIn('qwen/qwen3.8-27b:free', candidates)

    def test_catalog_fetch_filters_zero_prices_and_caches_for_ten_minutes(self):
        catalog={'data':[
            {'id':'vendor/current:free','pricing':{'prompt':'0','completion':'0','request':'0'},'architecture':{'input_modalities':['text']}},
            {'id':'vendor/paid:free','pricing':{'prompt':'0.01','completion':'0'},'architecture':{'input_modalities':['text']}},
        ]}
        class CatalogResponse:
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def read(self,n=-1):return json.dumps(catalog).encode()
        # Bypass the setUp stub to test the actual HTTP catalog path.
        with patch.object(worker, '_backup_open', return_value=CatalogResponse()) as http:
            models=REAL_OPENROUTER_CATALOG('synthetic-test-key',5.)
            again=REAL_OPENROUTER_CATALOG('synthetic-test-key',5.)
        self.assertEqual([item['id'] for item in models],['vendor/current:free'])
        self.assertEqual(models,again)
        http.assert_called_once()
        self.assertIn('sort=intelligence-high-to-low',http.call_args.args[0].full_url)

    def test_timeout_allocation_reserves_real_fallback_time(self):
        worker.chatgpt_auth.status=lambda:{'connected':True}
        with patch.object(worker,'_chatgpt_generate',side_effect=TimeoutError('read operation timed out')) as gpt, \
             patch.object(worker,'_gemini_generate_remote',side_effect=TimeoutError('read timed out')) as gem, \
             patch.object(worker,'_backup_open',return_value=Response()):
            # Mocked failures happen instantly; inspect computed budgets.
            self.ask()
        self.assertAlmostEqual(gpt.call_args.args[2], 25., delta=0.1)
        worker._backup_cooldowns.clear()
        with patch.object(worker,'_chatgpt_generate',side_effect=TimeoutError('read operation timed out')) as gpt150, \
             patch.object(worker,'_gemini_generate_remote',side_effect=TimeoutError('read operation timed out')) as gem150, \
             patch.object(worker,'_backup_open',return_value=Response()):
            worker._gemini_generate('AIza-synthetic',[{'text':'question'}],150,8192,'Cloud Ask',worker._validate_ask_response)
        self.assertAlmostEqual(gpt150.call_args.args[2],90.,delta=0.1)
        self.assertLessEqual(gem150.call_args.args[2],30.)
        self.assertLessEqual(gem.call_args.args[2], 30.)

    def test_no_configured_provider_fails_with_actionable_error(self):
        self.keys.clear()
        with self.assertRaisesRegex(RuntimeError,'No AI provider'):
            self.ask(api_key='')


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.session=patch.object(auth,'SESSION',Path(self.temp.name)/'.chatgpt-session.json')
        self.host=patch.object(auth,'HOST',Path(self.temp.name)/'.chatgpt-host-id')
        self.session.start();self.host.start()
        self.addCleanup(self.session.stop);self.addCleanup(self.host.stop)

    def test_host_identifier_is_stable_uuid_and_stored_privately(self):
        value=auth._host_id()
        self.assertTrue(value.startswith('urn:uuid:'))
        self.assertEqual(auth._host_id(),value)
        self.assertEqual(auth.HOST.stat().st_mode & 0o777,0o600)

    def test_first_sign_in_uses_real_pkce_and_validated_scope_not_private_chatgpt_apis(self):
        requests=[]
        def browser(url):
            args=urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            requests.append(args)
            def callback():
                redirect=args['redirect_uri'][0]+'?'+urllib.parse.urlencode({'state':args['state'][0],
                    'client_id':'oaiapp_testid','code':'example-code'})
                for _ in range(10):
                    try:
                        urllib.request.urlopen(redirect,timeout=3).read()
                        return
                    except OSError: time.sleep(.03)
            threading.Thread(target=callback,daemon=True).start()
            return True
        def token_response(url,**kwargs):
            self.assertEqual(url,auth.AUTH+'/api/accounts/oauth/token')
            form=kwargs['form']
            self.assertEqual(form['client_id'],'oaiapp_testid')
            self.assertEqual(form['code'],'example-code')
            self.assertGreater(len(form['code_verifier']),43)
            return {'scope':auth.SCOPES,'access_token':'test-access','refresh_token':'test-refresh',
                    'id_token':'test-id-token','expires_in':3600}
        with patch.object(auth.webbrowser,'open',side_effect=browser), \
             patch.object(auth,'_json_request',side_effect=token_response), \
             patch.object(auth,'_validate_id_token',return_value={'sub':'stable-user','email':'study@example.test'}) as validate:
            result=auth.login()
            self.assertTrue(result['connected'])
            self.assertEqual(result['email'],'study@example.test')
            self.assertEqual(auth.SESSION.stat().st_mode & 0o777,0o600)
            self.assertEqual(json.loads(auth.SESSION.read_text())['client_id'],'oaiapp_testid')
            validate.assert_called_once()
            info=requests[0]
            self.assertEqual(info['client_id'],['dynamic_agent_client'])
            self.assertEqual(info['code_challenge_method'],['S256'])
            self.assertEqual(info['agent_name_hint'],['LeNota'])
            self.assertEqual(info['resource'],[auth.RESOURCE])
            self.assertIn('chatgpt.tokens.use.direct',info['scope'][0])
            self.assertNotIn('test-access',str(info))

    def test_refresh_replaces_rotating_tokens_with_owner_only_file(self):
        auth._save(auth.SESSION, {'client_id':'oaiapp_test','scopes':auth.SCOPES.split(),
               'access_token':'expired','refresh_token':'old-refresh','saved_at':time.time()-4000,
               'expires_in':300})
        with patch.object(auth,'_json_request',return_value={
                'access_token':'new-access','refresh_token':'new-refresh','expires_in':3600,'scope':auth.SCOPES}) as request:
            self.assertEqual(auth.access_token(),'new-access')
            self.assertEqual(request.call_args.kwargs['form']['refresh_token'],'old-refresh')
            self.assertEqual(json.loads(auth.SESSION.read_text())['refresh_token'],'new-refresh')
            self.assertEqual(auth.SESSION.stat().st_mode&0o777,0o600)

    def test_rs256_oidc_signature_audience_nonce_and_tampering(self):
        try:
            from cryptography.hazmat.primitives.asymmetric import rsa, padding
            from cryptography.hazmat.primitives import hashes
        except ImportError:
            self.skipTest('cryptography unavailable (only necessary for test key generation)')
        private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        public=private.public_key().public_numbers()
        def b64int(num): return auth._b64(num.to_bytes((num.bit_length()+7)//8,'big'))
        jwk={'kid':'test-key','kty':'RSA','use':'sig','alg':'RS256',
             'n':b64int(public.n),'e':b64int(public.e)}
        def sign(claims):
            header=auth._b64(json.dumps({'alg':'RS256','kid':'test-key'}).encode())
            payload=auth._b64(json.dumps(claims).encode())
            text=(header+'.'+payload).encode('ascii')
            sig=private.sign(text,padding.PKCS1v15(),hashes.SHA256())
            return text.decode()+'.'+auth._b64(sig)
        good={'iss':auth.AUTH,'aud':'oaiapp_test','sub':'user-123',
              'exp':int(time.time())+3600,'iat':int(time.time()),'nonce':'nonce-123'}
        def metadata(url,**kwargs):
            return {'issuer':auth.AUTH,'jwks_uri':auth.AUTH+'/.well-known/testkeys'} if 'openid-configuration' in url else {'keys':[jwk]}
        with patch.object(auth,'_json_request',side_effect=metadata):
            self.assertEqual(auth._validate_id_token(sign(good),'oaiapp_test','nonce-123')['sub'],'user-123')
            with self.assertRaisesRegex(ValueError,'claims'):
                auth._validate_id_token(sign(good),'wrong-client','nonce-123')
            with self.assertRaisesRegex(ValueError,'claims'):
                auth._validate_id_token(sign(good),'oaiapp_test','wrong-nonce')
            forged=sign(good)
            signature=forged.rsplit('.',1)[1]
            tampered=forged.rsplit('.',1)[0]+'.'+('A' if signature[0]!='A' else 'B')+signature[1:]
            with self.assertRaisesRegex(ValueError,'signature'):
                auth._validate_id_token(tampered,'oaiapp_test','nonce-123')

    def test_disconnected_account_never_yields_access_token(self):
        with self.assertRaisesRegex(RuntimeError,'not connected'):
            auth.access_token()


if __name__=='__main__':unittest.main()
