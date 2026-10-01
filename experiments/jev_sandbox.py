"""Small local notebook client for the author's pinned jev08 implementation."""
from __future__ import annotations

import gc
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CHECKPOINT = ROOT / "models" / "jev-qwen35-08b"
os.environ["HF_HOME"] = str(ROOT / ".cache" / "huggingface")
os.environ["HF_HUB_CACHE"] = str(ROOT / ".cache" / "huggingface" / "hub")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import torch


def environment():
    info = {"python": sys.version.split()[0], "python_executable": sys.executable, "torch": torch.__version__}
    info["cuda_available"] = torch.cuda.is_available()
    if info["cuda_available"]:
        free, total = torch.cuda.mem_get_info(0)
        info.update(gpu=torch.cuda.get_device_name(0), gpu_free_gib=round(free / 2**30, 2), gpu_total_gib=round(total / 2**30, 2))
    return info


class JevSandbox:
    """Load once, edit state/questions freely, and reuse the model across cells."""

    def __init__(self, device="auto"):
        if device not in ("auto", "cpu", "cuda", "cuda:0"):
            raise ValueError("device must be auto, cpu, cuda or cuda:0")
        if not (CHECKPOINT / "model.json").exists():
            raise FileNotFoundError("Model files missing. Run setup.ps1 in experiments first.")
        if str(CHECKPOINT) not in sys.path:
            sys.path.insert(0, str(CHECKPOINT))
        from jev08.model import DecisionModel

        self.device = "cuda:0" if device == "cuda" else device
        if device == "auto":
            enough_gpu_memory = torch.cuda.is_available() and torch.cuda.mem_get_info(0)[0] >= 4 * 2**30
            self.device = "cuda:0" if enough_gpu_memory else "cpu"
        if self.device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError("CUDA unavailable. Choose DEVICE = 'cpu'.")
        if self.device == "cpu":
            torch.set_num_threads(min(8, os.cpu_count() or 1))
        self.temperature = json.loads((CHECKPOINT / "temperature.json").read_text(encoding="utf-8"))["temperature"]
        start = time.perf_counter()
        try:
            self.model = DecisionModel.load(CHECKPOINT, device=self.device)
        except torch.cuda.OutOfMemoryError:
            gc.collect()
            torch.cuda.empty_cache()
            raise RuntimeError("Not enough free GPU memory. Restart the kernel and choose DEVICE = 'cpu', or free GPU memory first.") from None
        self.load_seconds = time.perf_counter() - start
        self.max_length = self.model.max_length

    def decide(self, state, questions):
        if self.model is None:
            raise RuntimeError("Model was released. Create a new JevSandbox first.")
        from jev08.api import compile_request, format_response
        from jev08.metrics import softmax

        records = compile_request(state, questions)
        if self.device.startswith("cuda"):
            torch.cuda.synchronize()
        started = time.perf_counter()
        probabilities, input_tokens = [], 0
        with torch.inference_mode():
            # Questions remain isolated; processing one at a time reduces peak memory.
            for record in records:
                logits = self.model([record])[0]
                probabilities.append(softmax(logits.float().cpu().tolist(), temperature=self.temperature))
                input_tokens += self.model.last_input_tokens
        if self.device.startswith("cuda"):
            torch.cuda.synchronize()
        result = format_response(records, probabilities)
        result["meta"] = {
            "model": "guoan1/jev-qwen35-08b",
            "device": self.device,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "input_tokens": input_tokens,
            "temperature": self.temperature,
        }
        return result

    def close(self):
        self.model = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
