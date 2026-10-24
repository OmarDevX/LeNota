#!/usr/bin/env python3
"""Snapshot the desktop Gemini prompts for Rust mobile builds, without HTTP."""
import importlib.util
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "src-tauri/src"
spec = importlib.util.spec_from_file_location("worker", root / "cloud_ai_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class Captured(Exception):
    pass

prompts = []
def capture(_key, parts, *_args, **_kwargs):
    prompts.append(parts[0]["text"])
    raise Captured

worker._gemini_generate = capture
worker._image_part = lambda _path: {}
values = {}
operations = {
    "ask": lambda: worker.cloud_ask("__LN_PROMPT__", "__LN_CONTEXT__", "", 30),
    "ask_selection": lambda: worker.cloud_ask("__LN_PROMPT__", "__LN_CONTEXT__", "", 30, "image"),
    "math": lambda: worker.cloud_math_solve("__LN_LATEX__=", "", 30),
    "graph": lambda: worker.cloud_math_solve("__LN_LATEX__=", "", 30, True),
}
for name, operation in operations.items():
    try:
        operation()
    except Captured:
        values[name] = prompts[-1].replace("__LN_LATEX__=", "__LN_LATEX__")
for mode in ("text", "math", "auto"):
    try:
        worker.recognize_cloud_ink("image", "", 30, mode, "__LN_LANGUAGE__", "__LN_HINT__")
    except Captured:
        values["ink_" + mode] = prompts[-1]
values["models"] = worker._MODEL_NAMES
values["ink_models"] = worker._INK_MODEL_NAMES
(root / "mobile-ai-prompts.json").write_text(json.dumps(values, ensure_ascii=False, indent=2) + "\n")
print("Updated mobile-ai-prompts.json")
