"""Expose this isolated environment to Jupyter, including Anaconda Jupyter."""
import json
from pathlib import Path

from ipykernel.kernelspec import install

ROOT = Path(__file__).resolve().parent
destination = Path(install(user=True, kernel_name="minecraft-jev", display_name="Minecraft experiments - Jev 0.8B"))
kernel_file = destination / "kernel.json"
kernel = json.loads(kernel_file.read_text(encoding="utf-8"))
kernel["env"] = {
    "HF_HOME": str(ROOT / ".cache" / "huggingface"),
    "HF_HUB_CACHE": str(ROOT / ".cache" / "huggingface" / "hub"),
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "IPYTHONDIR": str(ROOT / ".cache" / "ipython"),
    "TOKENIZERS_PARALLELISM": "false",
    "PYTHONNOUSERSITE": "1",
}
kernel_file.write_text(json.dumps(kernel, indent=2) + "\n", encoding="utf-8")
print(f"Jupyter kernel registered: {destination}")
