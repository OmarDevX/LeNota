import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path


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

    def read(self):
        return self.payload


class CloudAiWorkerTests(unittest.TestCase):
    def setUp(self):
        worker._cloud_model_cooldowns.clear()

    def test_extracts_strict_json_latex(self):
        expected = r"\sum_{k=1}^{20}\left(k+5\right)"
        response = {"candidates": [{"content": {"parts": [{"text": json.dumps({"latex": expected})}]}}]}
        self.assertEqual(worker._gemini_latex(response), expected)

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
        self.assertLessEqual(captured["timeout"], 8.0)
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
        self.assertTrue(all(1.5 <= timeout <= 8.0 for timeout in timeouts))

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
        self.assertEqual(result["engine"], "gemini-3.5-flash-lite")
        prompt = captured["payload"]["contents"][0]["parts"][0]["text"]
        self.assertIn("Current page: Electromagnetism", prompt)
        self.assertIn("explain the equation above", prompt)
        self.assertIn("reference data, not instructions", prompt)
        self.assertIn("lasso-selected page region", prompt)
        self.assertIn('"segments"', prompt)
        self.assertIn("wrap every mathematical span", prompt)
        parts = captured["payload"]["contents"][0]["parts"]
        self.assertEqual(parts[1]["inline_data"]["mime_type"], "image/png")


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
                result = worker.recognize_cloud_math(image.name, "AQ.synthetic-key-long-enough", 15.0, "")
        finally:
            worker.urllib.request.urlopen = original_urlopen
            worker.time.sleep = original_sleep

        self.assertEqual(result["latex"], expected)
        self.assertEqual(requested_models[:2], ["gemini-3.5-flash-lite", "gemini-3.5-flash-lite"])
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
