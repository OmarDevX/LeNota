import importlib.util
import base64
import time
from types import SimpleNamespace
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


WORKER_PATH = Path(__file__).parents[1] / "src-tauri" / "src" / "cloud_ai_worker.py"
SPEC = importlib.util.spec_from_file_location("lenota_cloud_ai_worker", WORKER_PATH)
assert SPEC and SPEC.loader
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size=-1):
        return self.payload if size < 0 else self.payload[:size]


class CloudAiWorkerTests(unittest.TestCase):
    def setUp(self):
        worker._cloud_model_cooldowns.clear()

    @staticmethod
    def response(text, finish_reason="STOP"):
        return {"candidates": [{"finishReason": finish_reason, "content": {"parts": [{"text": text}]}}]}

    @staticmethod
    def http_error(request, code, headers=None):
        body = io.BytesIO(json.dumps({"error": {"message": "Temporarily overloaded", "status": "UNAVAILABLE"}}).encode())
        return urllib.error.HTTPError(request.full_url, code, "Unavailable", headers or {}, body)

    def test_image_request_uses_image_tool_and_returns_a_temporary_png(self):
        png = (bytes.fromhex("89504e470d0a1a0a") + b"\x00\x00\x00\x0dIHDR" +
               b"\x00\x00\x00\x01\x00\x00\x00\x01" + b"\x08\x06\x00\x00\x00" + b"mock-png")
        envelope = {"data": [{"b64_json": base64.b64encode(png).decode()}]}
        requests=[]
        def mock_open(request, timeout):
            requests.append(request)
            return FakeResponse(envelope)
        with tempfile.TemporaryDirectory() as images, \
             patch.object(worker, "_backup_keys", return_value={"openai_images":"sk-test-example-image-key"}), \
             patch.object(worker, "_backup_open", mock_open), \
             patch.object(worker, "_gemini_generate", side_effect=AssertionError("image must not fall back to text")):
            value=worker.cloud_ask("/raster draw a rabbit", "page reference", "", 60, image_output_dir=images)
            self.assertEqual(value["blocks"][0]["type"],"image")
            image_path=Path(value["blocks"][0]["image_path"])
            self.assertEqual(image_path.read_bytes(),png)
            self.assertEqual(image_path.parent,Path(images))
            payload=json.loads(requests[0].data)
            self.assertEqual(payload["model"],"gpt-image-2.5-flare")
            self.assertIn("/images/generations",requests[0].full_url)
            self.assertEqual(requests[0].get_header("Authorization"),"Bearer sk-test-example-image-key")
            self.assertIn("draw a rabbit",payload["prompt"])

    def test_image_request_failure_does_not_fall_back_to_prose(self):
        with tempfile.TemporaryDirectory() as images, \
             patch.object(worker, "_backup_keys", return_value={"openai_images":"sk-test-example-image-key"}), \
             patch.object(worker, "_backup_open",return_value=FakeResponse({"data":[]})), \
             patch.object(worker, "_gemini_generate", side_effect=AssertionError("wrong fallback")):
            with self.assertRaisesRegex(RuntimeError,"no generated PNG"):
                worker.cloud_ask("/raster a rabbit", "", "", 60, image_output_dir=images)
            self.assertFalse(list(Path(images).iterdir()))

    def test_explicit_raster_needs_api_key_and_never_tries_chatgpt_oauth(self):
        with tempfile.TemporaryDirectory() as images, \
             patch.object(worker, "_backup_keys", return_value={}), \
             patch.object(worker, "_backup_open", side_effect=AssertionError("must not call API")):
            with self.assertRaisesRegex(RuntimeError, "separately billed OpenAI API key"):
                worker.cloud_ask("/raster a rabbit", "", "", 60, image_output_dir=images)

    def test_image_api_error_reports_real_http_reason(self):
        def rejected(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 400, "Bad Request", {},
                io.BytesIO(b'{"error":{"code":"invalid_request_error","message":"invalid image size"}}'))
        with tempfile.TemporaryDirectory() as images, \
             patch.object(worker, "_backup_keys", return_value={"openai_images":"sk-test-example-image-key"}), \
             patch.object(worker, "_backup_open", side_effect=rejected):
            with self.assertRaisesRegex(RuntimeError, "HTTP 400: invalid image size"):
                worker.cloud_ask("/raster a rabbit", "", "", 60, image_output_dir=images)

    def test_ask_selection_uses_image_edits_with_the_selected_png(self):
        png = (bytes.fromhex("89504e470d0a1a0a") + b"\x00\x00\x00\x0dIHDR" +
               b"\x00\x00\x00\x01\x00\x00\x00\x01" + b"\x08\x06\x00\x00\x00" + b"mock-png")
        requests=[]
        def mock_open(request, timeout):
            requests.append(request)
            return FakeResponse({"data":[{"b64_json":base64.b64encode(png).decode()}]})
        with tempfile.TemporaryDirectory() as images, \
             patch.object(worker, "_backup_keys", return_value={"openai_images":"sk-test-example-image-key"}), \
             patch.object(worker, "_backup_open", side_effect=mock_open):
            selection=Path(images)/"selection.png"
            selection.write_bytes(png)
            result=worker.cloud_ask("/raster enhance the selection", "", "", 60,
                                    image_path=str(selection), image_output_dir=images)
            self.assertEqual(result["blocks"][0]["type"],"image")
            self.assertIn("/images/edits",requests[0].full_url)
            self.assertIn(b'name="image[]"',requests[0].data)
            self.assertIn(png,requests[0].data)

    def test_free_image_uses_only_existing_text_provider_no_billing(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><circle cx="100" cy="100" r="50"/></svg>'
        def mock_generate(key, parts, timeout, max_tokens, task, validate_response=None, **kwargs):
            self.assertIn("standalone, accurate, visually clear 2D SVG", parts[0]["text"])
            self.assertIn("moving current", parts[0]["text"])
            result = {"blocks": [{"type":"code", "language":"svg", "text": svg}]}
            validate_response(result)
            return result, "ChatGPT text"
        with patch.object(worker, "_backup_keys", return_value={"openai_images":"sk-paid-image-key"}), \
             patch.object(worker, "_gemini_generate", side_effect=mock_generate), \
             patch.object(worker, "_backup_open", side_effect=AssertionError("No billable image API may be called")):
            result = worker.cloud_ask("/image show moving current", "current circuit", "", 45)
        self.assertEqual(result["engine"], "ChatGPT text")
        self.assertEqual(result["blocks"], [{"type":"code", "language":"svg", "text": svg}])

    def test_free_image_can_use_selected_image_as_reference(self):
        with tempfile.NamedTemporaryFile(suffix=".png") as selection:
            selection.write(b"not-an-actual-png")
            selection.flush()
            def mock_generate(key, parts, timeout, max_tokens, task, validate_response=None, **kwargs):
                self.assertEqual(len(parts), 2)
                self.assertEqual(parts[1]["inline_data"]["mime_type"], "image/png")
                result = {"blocks": [{"type": "code", "language": "svg", "text":
                                     '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect width="300" height="200"/></svg>'}]}
                validate_response(result)
                return result, "text model"
            with patch.object(worker, "_backup_keys", return_value={}), \
                 patch.object(worker, "_gemini_generate", side_effect=mock_generate):
                value = worker.cloud_ask("/image turn this selection into a diagram", "", "", 45,
                                         image_path=selection.name)
            self.assertEqual(value["blocks"][0]["language"], "svg")

    def test_free_image_rejects_prose_or_unsafe_svg(self):
        with self.assertRaisesRegex(RuntimeError, "did not return the requested SVG"):
            worker._validate_free_svg_response({"blocks": [{"type":"paragraph", "text":"Unable to draw"}]})
        with self.assertRaisesRegex(RuntimeError, "unsafe SVG"):
            worker._validate_free_svg_response({"blocks": [{"type":"code", "language":"svg", "text":
                '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'}]})

    def test_repairs_invalid_latex_escapes_and_unicode_prefix_commands(self):
        text = r'{"blocks":[{"type":"math","latex":"\left(\frac{1}{2}\right)\,\underbrace{x}_{\alpha}"}]}'
        value = worker._gemini_response_json(self.response(text))
        repaired = worker._repair_latex_fields(value)
        self.assertEqual(repaired["blocks"][0]["latex"], r"\left(\frac{1}{2}\right)\,\underbrace{x}_{\alpha}")

    def test_preserves_valid_json_strings_including_code_and_unicode(self):
        value = {"blocks": [{"type": "code", "text": 'print("hello")\n\tpath = "C:\\tmp\\new"\n', "language": "python"},
                            {"type": "paragraph", "text": "Türkçe العربية 😀"},
                            {"type": "math", "latex": r"\begin{matrix}a&b\\c&d\end{matrix}"}]}
        text = json.dumps(value)
        self.assertEqual(worker._repair_invalid_json_escapes(text), text)
        self.assertEqual(worker._gemini_response_json(self.response(text)), value)

    def test_repairs_invalid_escape_without_changing_other_valid_strings(self):
        prefix = json.dumps({"text": 'quoted "text"\n\tالعربية 😀', "code": r"C:\tmp\new"})
        text = prefix[:-1] + r',"latex":"\alpha\,x"}'
        parsed = worker._gemini_response_json(self.response(text))
        self.assertEqual(parsed["text"], 'quoted "text"\n\tالعربية 😀')
        self.assertEqual(parsed["code"], r"C:\tmp\new")
        self.assertEqual(parsed["latex"], r"\alpha\,x")

    def test_does_not_accept_broken_json_structure(self):
        for text in [r'{"blocks":[{"type":"math","latex":"\alpha"}', '{"blocks":[]} trailing', '{"blocks": [1,]}', '[]']:
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                worker._gemini_response_json(self.response(text))

    def test_rejects_truncated_response_even_when_partial_json_is_valid(self):
        with self.assertRaisesRegex(RuntimeError, "MAX_TOKENS"):
            worker._gemini_response_json(self.response('{"blocks":[{"type":"paragraph","text":"partial"}]}', "MAX_TOKENS"))

    def test_ignores_thinking_parts_and_accepts_fenced_json(self):
        response = self.response('```json\n{"blocks":[{"type":"paragraph","text":"answer"}]}\n```')
        response["candidates"][0]["content"]["parts"].insert(0, {"thought": True, "text": "thinking is not JSON"})
        self.assertEqual(worker._gemini_response_json(response)["blocks"][0]["text"], "answer")

    def test_screenshot_failure_503_then_invalid_escape_succeeds(self):
        requests = []
        raw = r'{"blocks":[{"type":"paragraph","segments":[{"type":"text","text":"Velocity: "},{"type":"math","latex":"v=\frac{\Delta x}{\Delta t}"}]}]}'

        def urlopen(request, timeout):
            requests.append(request)
            if len(requests) == 1:
                raise self.http_error(request, 503)
            return FakeResponse(self.response(raw))

        with patch.object(worker.urllib.request, "urlopen", urlopen):
            result = worker.cloud_ask("explain", "", "test-key", 45)
        self.assertEqual(len(requests), 2)
        self.assertEqual(result["engine"], worker._MODEL_NAMES[1])
        self.assertEqual(result["blocks"][0]["segments"][1]["latex"], r"v=\frac{\Delta x}{\Delta t}")
        config = json.loads(requests[1].data)["generationConfig"]
        self.assertEqual(config["responseMimeType"], "application/json")
        self.assertEqual(config, {"temperature": 0, "maxOutputTokens": 8192, "responseMimeType": "application/json"})

    def test_regenerates_once_when_json_has_unusable_note_content(self):
        for bad in [{"blocks": []}, {"blocks": [{"type": "unsupported", "text": "lost"}]},
                    {"blocks": [{"type": "paragraph"}]}, {"blocks": [{"type": "math", "latex": 123}]}]:
            worker._cloud_model_cooldowns.clear()
            responses = [FakeResponse(self.response(json.dumps(bad))),
                         FakeResponse(self.response('{"blocks":[{"type":"paragraph","text":"OK"}]}'))]
            with self.subTest(bad=bad), patch.object(worker.urllib.request, "urlopen", side_effect=responses):
                self.assertEqual(worker.cloud_ask("explain", "", "test-key", 45)["engine"], worker._MODEL_NAMES[0])

    def test_regenerates_unrepairable_json_and_token_truncation_without_guessing(self):
        for bad in [self.response('{"blocks":'), self.response('{"blocks":[]}', "MAX_TOKENS")]:
            worker._cloud_model_cooldowns.clear()
            responses = [FakeResponse(bad), FakeResponse(self.response('{"blocks":[{"type":"paragraph","text":"OK"}]}'))]
            with self.subTest(bad=bad), patch.object(worker.urllib.request, "urlopen", side_effect=responses):
                self.assertEqual(worker.cloud_ask("explain", "", "test-key", 45)["engine"], worker._MODEL_NAMES[0])

    def test_screenshot_overload_then_broken_json_regenerates_graph_with_original_selection(self):
        requests = []
        graph = {"type":"graph", "relation_latex":r"y=\frac{1}{x}", "x_min":-5, "x_max":5, "y_min":-5, "y_max":5, "title":"Reciprocal"}

        def urlopen(request, timeout):
            requests.append(request)
            if len(requests) == 1:
                raise self.http_error(request, 503)
            if len(requests) == 2:
                return FakeResponse(self.response('{"blocks":[{"type":"graph" "relation_latex":"y=1/x"}]}'))
            return FakeResponse(self.response(json.dumps({"blocks":[graph]})))

        with tempfile.NamedTemporaryFile(suffix=".png") as image:
            image.write(b"selected-function"); image.flush()
            with patch.object(worker.urllib.request, "urlopen", urlopen):
                result=worker.cloud_ask("sketch this function", "original-page-equation", "test-key", 45, image.name)
        self.assertEqual(result["blocks"], [graph])
        self.assertEqual([r.full_url.split("/models/")[1].split(":")[0] for r in requests],
                         [worker._MODEL_NAMES[0], worker._MODEL_NAMES[1], worker._MODEL_NAMES[1]])
        first, retry = json.loads(requests[1].data), json.loads(requests[2].data)
        self.assertEqual(retry["generationConfig"], first["generationConfig"])
        self.assertEqual(retry["contents"][0]["parts"][:-1], first["contents"][0]["parts"])
        self.assertIn("previous reply was rejected", retry["contents"][0]["parts"][-1]["text"])
        self.assertIn('"type":"graph"', first["contents"][0]["parts"][0]["text"])

    def test_invalid_content_retry_is_once_total_and_stays_inside_deadline(self):
        clock=[100.0]
        calls=[]

        def urlopen(request, timeout):
            calls.append(request)
            clock[0]+=timeout
            return FakeResponse(self.response('{"blocks":'))

        with patch.object(worker.urllib.request,"urlopen",urlopen), patch.object(worker.time,"monotonic",side_effect=lambda:clock[0]):
            with self.assertRaisesRegex(RuntimeError,"malformed JSON"):
                worker.cloud_ask("sketch", "", "test-key", 45)
        self.assertLessEqual(clock[0],145.0)
        self.assertLessEqual(len(calls),len(worker._MODEL_NAMES)+1)
        self.assertEqual(sum(len(json.loads(r.data)["contents"][0]["parts"])>1 for r in calls),1)

    def test_graph_validation_rejects_code_free_parameters_and_bad_ranges(self):
        graph={"type":"graph","relation_latex":"y=x^2","x_min":-5,"x_max":5,"y_min":-2,"y_max":25}
        worker._validate_ask_response({"blocks":[graph]})
        for patch_value in [{"relation_latex":"y=alert(x)"},{"relation_latex":"y=ax"},
                            {"x_max":float("inf")},{"y_min":30},{"x_min":True},
                            {"relation_latex":r"y=\int x dx"}]:
            with self.subTest(patch_value=patch_value), self.assertRaisesRegex(RuntimeError,"invalid graph"):
                worker._validate_ask_response({"blocks":[{**graph,**patch_value}]})

    def test_blocked_candidates_are_not_regenerated(self):
        calls=[]
        def urlopen(request, timeout):
            calls.append(request)
            return FakeResponse(self.response('{}',"SAFETY"))
        with patch.object(worker.urllib.request,"urlopen",urlopen):
            with self.assertRaisesRegex(RuntimeError,"SAFETY"):
                worker.cloud_ask("test", "", "test-key",45)
        self.assertEqual(len(calls),len(worker._MODEL_NAMES))

    def test_retries_overloaded_models_after_trying_alternatives(self):
        models = []
        clock = [100.0]

        def urlopen(request, timeout):
            models.append(request.full_url.split("/models/")[1].split(":")[0])
            if len(models) <= len(worker._MODEL_NAMES):
                raise self.http_error(request, 503)
            return FakeResponse(self.response('{"blocks":[{"type":"paragraph","text":"OK"}]}'))

        with patch.object(worker.urllib.request, "urlopen", urlopen), patch.object(worker.time, "monotonic", side_effect=lambda: clock[0]), patch.object(worker.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            result = worker.cloud_ask("explain", "", "test-key", 45)
        self.assertEqual(models, [*worker._MODEL_NAMES, worker._MODEL_NAMES[0]])
        self.assertEqual(result["engine"], worker._MODEL_NAMES[0])
        self.assertAlmostEqual(clock[0], 100.5)

    def test_all_overloaded_models_have_bounded_retries(self):
        clock = [100.0]
        calls = []

        def urlopen(request, timeout):
            calls.append(request)
            raise self.http_error(request, 503)

        with patch.object(worker.urllib.request, "urlopen", urlopen), patch.object(worker.time, "monotonic", side_effect=lambda: clock[0]), patch.object(worker.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)):
            with self.assertRaisesRegex(RuntimeError, "503"):
                worker.cloud_ask("explain", "", "test-key", 45)
        self.assertEqual(len(calls), 2 * len(worker._MODEL_NAMES))

    def test_honors_long_retry_after_without_waiting_or_retrying_too_soon(self):
        calls = []

        def urlopen(request, timeout):
            calls.append(request)
            raise self.http_error(request, 503, {"Retry-After": "120"})

        with patch.object(worker.urllib.request, "urlopen", urlopen), patch.object(worker.time, "sleep") as sleep:
            with self.assertRaises(RuntimeError):
                worker.cloud_ask("explain", "", "test-key", 45)
        self.assertEqual(len(calls), len(worker._MODEL_NAMES))
        sleep.assert_not_called()

    def test_deadline_limits_fallback_requests(self):
        clock = [100.0]
        timeouts = []

        def urlopen(request, timeout):
            timeouts.append(timeout)
            clock[0] += timeout
            raise TimeoutError("read timed out")

        with patch.object(worker.urllib.request, "urlopen", urlopen), patch.object(worker.time, "monotonic", side_effect=lambda: clock[0]):
            with self.assertRaises(RuntimeError):
                worker.cloud_ask("explain", "", "test-key", 45)
        self.assertEqual(timeouts, [15.0, 15.0, 15.0])
        self.assertEqual(clock[0], 145.0)

    def test_authentication_error_stops_without_leaking_key(self):
        key = "synthetic-private-key"

        def urlopen(request, timeout):
            body = io.BytesIO(json.dumps({"error": {"message": "Rejected " + key}}).encode())
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, body)

        with patch.object(worker.urllib.request, "urlopen", side_effect=urlopen) as mocked:
            with self.assertRaises(RuntimeError) as caught:
                worker.cloud_ask("explain", "", key, 45)
        self.assertNotIn(key, str(caught.exception))
        self.assertEqual(mocked.call_count, 1)

    def test_ask_request_uses_previously_accepted_config_for_every_fallback(self):
        requests = []

        def urlopen(request, timeout):
            payload = json.loads(request.data)
            self.assertEqual(set(payload), {"contents", "generationConfig"})
            self.assertEqual(payload["generationConfig"], {
                "temperature": 0, "maxOutputTokens": 8192, "responseMimeType": "application/json",
            })
            self.assertEqual(request.get_method(), "POST")
            requests.append(request)
            if len(requests) < len(worker._MODEL_NAMES):
                raise self.http_error(request, 503)
            return FakeResponse(self.response('{"blocks":[{"type":"paragraph","text":"OK"}]}'))

        with patch.object(worker.urllib.request, "urlopen", urlopen):
            result = worker.cloud_ask("explain", "page context", "test-key", 45)
        self.assertEqual(len(requests), len(worker._MODEL_NAMES))
        self.assertEqual(result["engine"], worker._MODEL_NAMES[-1])
        self.assertEqual(len({request.data for request in requests}), 1)

    def test_visual_ask_keeps_png_and_page_context_without_schema_config(self):
        captured = []

        def urlopen(request, timeout):
            captured.append(json.loads(request.data))
            return FakeResponse(self.response(r'{"blocks":[{"type":"math","latex":"\Delta x=v\,t"}]}'))

        with tempfile.NamedTemporaryFile(suffix=".png") as image:
            image.write(b"selected-region-bytes")
            image.flush()
            with patch.object(worker.urllib.request, "urlopen", urlopen):
                result = worker.cloud_ask("explain region", "current-page-reference", "test-key", 45, image.name)
        self.assertEqual(captured[0]["generationConfig"], {
            "temperature": 0, "maxOutputTokens": 8192, "responseMimeType": "application/json",
        })
        parts = captured[0]["contents"][0]["parts"]
        self.assertIn("current-page-reference", parts[0]["text"])
        self.assertIn("explain region", parts[0]["text"])
        self.assertEqual(parts[1]["inline_data"]["mime_type"], "image/png")
        self.assertEqual(result["blocks"][0]["latex"], r"\Delta x=v\,t")

    def test_extracts_strict_json_latex(self):
        expected = r"\sum_{k=1}^{20}\left(k+5\right)"
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({"latex": expected})}]}}]}
        self.assertEqual(worker._gemini_latex(response), expected)

    def test_all_ink_modes_use_lite_first_and_keep_original_request_format(self):
        for mode in ("auto", "math", "text"):
            requests = []
            result_value = {"kind": "text", "text": "hello"} if mode == "text" else {"kind": "math", "latex": "x+1"}

            def urlopen(request, timeout):
                requests.append(request)
                self.assertLessEqual(timeout, 5.0)
                config = json.loads(request.data)["generationConfig"]
                self.assertEqual(config, {"temperature": 0, "maxOutputTokens": 2048, "responseMimeType": "application/json"})
                return FakeResponse(self.response(json.dumps(result_value)))

            with self.subTest(mode=mode), tempfile.NamedTemporaryFile(suffix=".png") as image:
                image.write(b"ink-image"); image.flush()
                with patch.object(worker.urllib.request, "urlopen", urlopen):
                    result = worker.recognize_cloud_ink(image.name, "test-key", 15, mode, "eng", "")
            self.assertEqual(result["engine"], worker._INK_MODEL_NAMES[0])
            self.assertEqual(len(requests), 1)

    def test_ink_does_not_wait_or_retry_overloaded_models(self):
        calls = []

        def urlopen(request, timeout):
            calls.append(request.full_url.split("/models/")[1].split(":")[0])
            raise self.http_error(request, 503, {"Retry-After": "2"})

        with tempfile.NamedTemporaryFile(suffix=".png") as image:
            image.write(b"ink-image"); image.flush()
            with patch.object(worker.urllib.request, "urlopen", urlopen), patch.object(worker.time, "sleep") as sleep:
                with self.assertRaisesRegex(RuntimeError, "503"):
                    worker.recognize_cloud_ink(image.name, "test-key", 15, "auto", "eng", "")
        self.assertEqual(calls, list(worker._INK_MODEL_NAMES))
        sleep.assert_not_called()

    def test_ink_quota_error_moves_to_second_lite_without_waiting(self):
        calls = []

        def urlopen(request, timeout):
            calls.append(request.full_url.split("/models/")[1].split(":")[0])
            if len(calls) == 1:
                raise self.http_error(request, 429, {"Retry-After": "1"})
            return FakeResponse(self.response('{"kind":"math","latex":"x+1"}'))

        with tempfile.NamedTemporaryFile(suffix=".png") as image:
            image.write(b"ink-image"); image.flush()
            with patch.object(worker.urllib.request, "urlopen", urlopen), patch.object(worker.time, "sleep") as sleep:
                result = worker.recognize_cloud_ink(image.name, "test-key", 15, "auto", "eng", "")
        self.assertEqual(calls, list(worker._INK_MODEL_NAMES))
        self.assertEqual(result["engine"], worker._INK_MODEL_NAMES[1])
        sleep.assert_not_called()

    def test_slow_ink_uses_two_bounded_attempts_without_full_flash(self):
        clock = [100.0]
        timeouts = []

        def urlopen(request, timeout):
            self.assertTrue(any(name + ":generateContent" in request.full_url for name in worker._INK_MODEL_NAMES))
            timeouts.append(timeout)
            clock[0] += timeout
            raise TimeoutError("read timed out")

        with tempfile.NamedTemporaryFile(suffix=".png") as image:
            image.write(b"ink-image"); image.flush()
            with patch.object(worker.urllib.request, "urlopen", urlopen), patch.object(worker.time, "monotonic", side_effect=lambda: clock[0]):
                with self.assertRaises(RuntimeError):
                    worker.recognize_cloud_ink(image.name, "test-key", 15, "auto", "eng", "")
        self.assertEqual(timeouts, [5.0, 5.0])
        self.assertEqual(clock[0], 110.0)

    def test_sends_whole_png_and_returns_expression(self):
        expected = r"\sum_{k=1}^{20}\left(k+5\right)"
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({"latex": expected})}]}}]}
        captured = {}

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return FakeResponse(response)

        original = worker.urllib.request.urlopen
        worker.urllib.request.urlopen = fake_urlopen
        try:
            with tempfile.NamedTemporaryFile(suffix=".png") as image:
                image.write(b"not-a-real-png-but-valid-request-bytes")
                image.flush()
                result = worker.recognize_cloud_math(image.name, "AIza-test-key-long-enough-123", 15.0, "leading operator is sum")
        finally:
            worker.urllib.request.urlopen = original

        self.assertEqual(result["latex"], expected)
        self.assertGreaterEqual(captured["timeout"], 1.5)
        self.assertLessEqual(captured["timeout"], 5.0)
        request = captured["request"]
        self.assertTrue(request.full_url.endswith("gemini-3.5-flash-lite:generateContent"))
        self.assertEqual(request.get_header("X-goog-api-key"), "AIza-test-key-long-enough-123")
        payload = json.loads(request.data.decode("utf-8"))
        parts = payload["contents"][0]["parts"]
        self.assertEqual(parts[1]["inline_data"]["mime_type"], "image/png")
        self.assertIn("leading operator is sum", parts[0]["text"])

    def test_tries_another_free_flash_model_after_model_specific_quota_error(self):
        expected = r"\int_0^1 x^2\,dx"
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({"latex": expected})}]}}]}
        requested_models = []

        def fake_urlopen(request, timeout):
            requested_models.append(request.full_url.split("/models/", 1)[1].split(":", 1)[0])
            if len(requested_models) == 1:
                detail = io.BytesIO(json.dumps({
                    "error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Free-tier quota is 0 for this model."}
                }).encode("utf-8"))
                raise urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", {}, detail)
            return FakeResponse(response)

        original = worker.urllib.request.urlopen
        worker.urllib.request.urlopen = fake_urlopen
        try:
            with tempfile.NamedTemporaryFile(suffix=".png") as image:
                image.write(b"request-bytes")
                image.flush()
                result = worker.recognize_cloud_math(image.name, "AQ.synthetic-key-long-enough", 15.0, "")
        finally:
            worker.urllib.request.urlopen = original

        self.assertEqual(result["latex"], expected)
        self.assertEqual(requested_models[:2], ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"])

    def test_tries_next_flash_model_when_first_model_is_overloaded(self):
        expected = r"\sum_{k=1}^{10} k"
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({"latex": expected})}]}}]}
        requested_models = []

        def fake_urlopen(request, timeout):
            requested_models.append(request.full_url.split("/models/", 1)[1].split(":", 1)[0])
            if len(requested_models) == 1:
                detail = io.BytesIO(json.dumps({
                    "error": {"code": 503, "status": "UNAVAILABLE", "message": "This model is currently experiencing high demand."}
                }).encode("utf-8"))
                raise urllib.error.HTTPError(request.full_url, 503, "Service Unavailable", {}, detail)
            return FakeResponse(response)

        original = worker.urllib.request.urlopen
        worker.urllib.request.urlopen = fake_urlopen
        try:
            with tempfile.NamedTemporaryFile(suffix=".png") as image:
                image.write(b"request-bytes")
                image.flush()
                result = worker.recognize_cloud_math(image.name, "AQ.synthetic-key-long-enough", 15.0, "")
        finally:
            worker.urllib.request.urlopen = original

        self.assertEqual(result["latex"], expected)
        self.assertEqual(requested_models[:2], ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"])

    def test_tries_next_flash_model_when_first_model_times_out(self):
        expected = r"\frac{x+1}{2}"
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({"latex": expected})}]}}]}
        requested_models = []
        timeouts = []

        def fake_urlopen(request, timeout):
            requested_models.append(request.full_url.split("/models/", 1)[1].split(":", 1)[0])
            timeouts.append(timeout)
            if len(requested_models) == 1:
                raise TimeoutError("The read operation timed out")
            return FakeResponse(response)

        original = worker.urllib.request.urlopen
        worker.urllib.request.urlopen = fake_urlopen
        try:
            with tempfile.NamedTemporaryFile(suffix=".png") as image:
                image.write(b"request-bytes")
                image.flush()
                result = worker.recognize_cloud_math(image.name, "AQ.synthetic-key-long-enough", 15.0, "")
        finally:
            worker.urllib.request.urlopen = original

        self.assertEqual(result["latex"], expected)
        self.assertEqual(requested_models[:2], ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"])
        self.assertTrue(all(1.5 <= timeout <= 5.0 for timeout in timeouts))

    def test_transcribes_handwriting_as_text(self):
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({"kind": "text", "text": "Gauss's law"})}]}}]}
        original = worker.urllib.request.urlopen
        worker.urllib.request.urlopen = lambda _request, timeout: FakeResponse(response)
        try:
            with tempfile.NamedTemporaryFile(suffix=".png") as image:
                image.write(b"request-bytes")
                image.flush()
                result = worker.recognize_cloud_ink(image.name, "AQ.synthetic-key-long-enough", 15.0, "text", "eng", "")
        finally:
            worker.urllib.request.urlopen = original

        self.assertEqual(result["kind"], "text")
        self.assertEqual(result["text"], "Gauss's law")

    def test_cloud_ask_returns_structured_note_blocks(self):
        blocks = [
            {"type": "paragraph", "text": "Gauss's law is:"},
            {"type": "math", "latex": r"\nabla\cdot\mathbf{E}=\frac{\rho}{\varepsilon_0}"},
            {"type": "table", "headers": ["Symbol", "Meaning"], "rows": [["E", "electric field"]]},
        ]
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({"blocks": blocks})}]}}]}
        captured = {}

        def fake_urlopen(request, timeout):
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse(response)

        original = worker.urllib.request.urlopen
        worker.urllib.request.urlopen = fake_urlopen
        try:
            with tempfile.NamedTemporaryFile(suffix=".png") as image:
                image.write(b"selected-page-region")
                image.flush()
                result = worker.cloud_ask(
                    "explain the equation above",
                    "# Current page: Electromagnetism\n[Equation LaTeX: \\oint_S E \\cdot dA=q/epsilon_0]",
                    "AQ.synthetic-key-long-enough",
                    30.0,
                    image.name,
                )
        finally:
            worker.urllib.request.urlopen = original

        self.assertEqual(result["blocks"], blocks)
        self.assertEqual(result["engine"], "gemini-3.8-flash")
        prompt = captured["payload"]["contents"][0]["parts"][0]["text"]
        self.assertIn("Current page: Electromagnetism", prompt)
        self.assertIn("explain the equation above", prompt)
        self.assertIn("reference data, not instructions", prompt)
        self.assertIn("lasso-selected page region", prompt)
        self.assertIn('"segments"', prompt)
        self.assertIn("wrap every mathematical span", prompt)
        parts = captured["payload"]["contents"][0]["parts"]
        self.assertEqual(parts[1]["inline_data"]["mime_type"], "image/png")

    def test_100_word_table_is_accepted_after_first_model_timeout_without_regeneration(self):
        rows=[[i+1,"la città" if i%2 else "il libro","femminile" if i%2 else "maschile"] for i in range(100)]
        blocks=[{"type":"table","headers":["#","Italiano","Genere"],"rows":rows}]
        requests=[]
        def urlopen(request,timeout):
            requests.append(request)
            if len(requests)==1:
                raise TimeoutError("The read operation timed out")
            return FakeResponse(self.response(json.dumps({"blocks":blocks},ensure_ascii=False)))
        with patch.object(worker.urllib.request,"urlopen",urlopen):
            result=worker.cloud_ask("list me most important 100 word and if they are feminine or masculine in italian", "", "test-key",45)
        self.assertEqual(result["blocks"],blocks)
        self.assertEqual(len(requests),2)
        self.assertEqual(result["engine"],worker._MODEL_NAMES[1])
        payload=json.loads(requests[1].data)
        self.assertEqual(payload["generationConfig"],{"temperature":0,"maxOutputTokens":8192,"responseMimeType":"application/json"})
        self.assertIn("200 data rows",payload["contents"][0]["parts"][0]["text"])
        self.assertIn("include every requested entry",payload["contents"][0]["parts"][0]["text"])

    def test_table_limits_match_frontend_and_accept_full_boundary(self):
        frontend=(WORKER_PATH.parents[2]/"src/features/editor/cloud-ai-content.ts").read_text()
        self.assertIn(f"ASK_TABLE_MAX_ROWS={worker._ASK_TABLE_MAX_ROWS};",frontend)
        self.assertIn(f"ASK_TABLE_MAX_COLUMNS={worker._ASK_TABLE_MAX_COLUMNS};",frontend)
        block={"type":"table","headers":["Entry"],"rows":[[i+1] for i in range(worker._ASK_TABLE_MAX_ROWS)]}
        worker._validate_ask_response({"blocks":[block]})
        with self.assertRaisesRegex(RuntimeError,"invalid table"):
            worker._validate_ask_response({"blocks":[{**block,"rows":[*block["rows"],["extra"]]}]})

    def test_table_numbers_allow_finite_values_without_weakening_structure_checks(self):
        block={"type":"table","headers":["Value"],"rows":[[0],[-2],[3.25],[{"segments":[{"type":"math","latex":"x^2"}]}]]}
        worker._validate_ask_response({"blocks":[block]})
        for rows in [[[float("nan")]],[[float("inf")]],[[None]],[[{"bad":"cell"}]],["not a row"],[list(range(13))]]:
            with self.subTest(rows=rows),self.assertRaisesRegex(RuntimeError,"invalid table"):
                worker._validate_ask_response({"blocks":[{**block,"rows":rows}]})

    def test_large_table_response_still_obeys_overall_byte_budget(self):
        block={"type":"table","headers":["Value"],"rows":[["x"*32000] for _ in range(7)]}
        with self.assertRaisesRegex(RuntimeError,"200 KB"):
            worker._validate_ask_response({"blocks":[block]})


    def test_cloud_math_solves_calculus_and_returns_safe_graph_spec(self):
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({
            "status": "solved",
            "result_latex": r"3x^2",
            "graph": {
                "relation_latex": r"y=3x^2",
                "x_min": -5,
                "x_max": 5,
                "y_min": -2,
                "y_max": 30,
                "title": "Derivative",
            },
        })}]}}]}
        captured = {}

        def fake_urlopen(request, timeout):
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse(response)

        original = worker.urllib.request.urlopen
        worker.urllib.request.urlopen = fake_urlopen
        try:
            result = worker.cloud_math_solve(r"\frac{d}{dx}x^3=", "AQ.synthetic-key-long-enough", 30.0)
        finally:
            worker.urllib.request.urlopen = original

        self.assertEqual(result["status"], "solved")
        self.assertEqual(result["resultLatex"], r"3x^2")
        self.assertEqual(result["graph"]["relationLatex"], r"y=3x^2")
        prompt = captured["payload"]["contents"][0]["parts"][0]["text"]
        self.assertIn("multiple variables", prompt)
        self.assertIn("partial derivatives", prompt)
        self.assertIn(r"\frac{d}{dx}x^3=", prompt)

    def test_force_graph_explicitly_tells_gemini_to_return_a_graph(self):
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({
            "status": "relation",
            "result_latex": r"x=2",
            "graph": {
                "relation_latex": r"2x+3=7",
                "x_min": -5,
                "x_max": 5,
                "y_min": -5,
                "y_max": 5,
                "title": "Equation graph",
            },
        })}]}}]}
        captured = {}

        def fake_urlopen(request, timeout):
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse(response)

        original = worker.urllib.request.urlopen
        worker.urllib.request.urlopen = fake_urlopen
        try:
            result = worker.cloud_math_solve(r"2x+3=7", "AQ.synthetic-key-long-enough", 30.0, True)
        finally:
            worker.urllib.request.urlopen = original

        self.assertEqual(result["graph"]["relationLatex"], r"2x+3=7")
        prompt = captured["payload"]["contents"][0]["parts"][0]["text"]
        self.assertIn("explicitly requested a graph", prompt)

    def test_honors_short_provider_retry_delay_before_falling_back(self):
        expected = r"x^2+1"
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({"latex": expected})}]}}]}
        requested_models = []
        sleeps = []

        def fake_urlopen(request, timeout):
            requested_models.append(request.full_url.split("/models/", 1)[1].split(":", 1)[0])
            if len(requested_models) == 1:
                detail = io.BytesIO(json.dumps({
                    "error": {
                        "code": 429,
                        "status": "RESOURCE_EXHAUSTED",
                        "message": "Request limit: 20. Please retry in 0.01s.",
                        "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "0.01s"}],
                    }
                }).encode("utf-8"))
                raise urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", {}, detail)
            return FakeResponse(response)

        original_urlopen = worker.urllib.request.urlopen
        original_sleep = worker.time.sleep
        worker.urllib.request.urlopen = fake_urlopen
        worker.time.sleep = lambda seconds: sleeps.append(seconds)
        try:
            with tempfile.NamedTemporaryFile(suffix=".png") as image:
                image.write(b"request-bytes")
                image.flush()
                value, _engine = worker._gemini_generate("AQ.synthetic-key-long-enough", [{"text": "test request"}], 15.0, 2048, "Cloud Ask")
                result = {"latex": value["latex"]}
        finally:
            worker.urllib.request.urlopen = original_urlopen
            worker.time.sleep = original_sleep

        self.assertEqual(result["latex"], expected)
        self.assertEqual(requested_models[:2], ["gemini-3.8-flash", "gemini-3.8-flash"])
        self.assertEqual(len(sleeps), 1)
        self.assertGreaterEqual(sleeps[0], 0.01)

    def test_repairs_json_control_escapes_in_latex_fields(self):
        corrupted = "\\left(\\frac{1}{x}" + "\r" + "ight) + " + "\t" + "ext{ok}"
        repaired = worker._repair_latex_fields([{"type":"math","latex":corrupted}])
        self.assertEqual(repaired[0]["latex"], r"\left(\frac{1}{x}\right) + \text{ok}")

    def test_clean_latex_restores_formfeed_fraction(self):
        corrupted = "" + "\f" + "rac{1}{2}"
        self.assertEqual(worker._clean_latex(corrupted), r"\frac{1}{2}")


if __name__ == "__main__":
    unittest.main()
