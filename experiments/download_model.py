"""Download the pinned community checkpoint and base model into this sandbox."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ["HF_HOME"] = str(ROOT / ".cache" / "huggingface")
os.environ["HF_HUB_CACHE"] = str(ROOT / ".cache" / "huggingface" / "hub")
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["HF_HUB_OFFLINE"] = "0"
os.environ["HF_XET_CACHE"] = str(ROOT / ".cache" / "xet")

from huggingface_hub import snapshot_download

ADAPTER_ID = "guoan1/jev-qwen35-08b"
ADAPTER_REVISION = "62986e6dce924fff167dea9d7469b01f9e7e7ff2"
CHECKPOINT = ROOT / "models" / "jev-qwen35-08b"


def main():
    snapshot_download(
        ADAPTER_ID,
        revision=ADAPTER_REVISION,
        local_dir=CHECKPOINT,
        allow_patterns=["adapter/*", "jev08/*.py", "head.pt", "model.json", "temperature.json", "LICENSE-NOTICES", "README.md"],
        max_workers=4,
    )
    config = json.loads((CHECKPOINT / "model.json").read_text(encoding="utf-8"))
    base_path = snapshot_download(
        config["model_id"],
        revision=config["revision"],
        allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt", "*.jinja"],
        max_workers=4,
    )
    provenance = {
        "adapter_id": ADAPTER_ID,
        "adapter_revision": ADAPTER_REVISION,
        "base_id": config["model_id"],
        "base_revision": config["revision"],
        "base_cache_path": str(base_path),
        "max_length": config["max_length"],
    }
    (ROOT / "models" / "provenance.json").write_text(
        json.dumps(provenance, indent=2) + "\n", encoding="utf-8"
    )
    print("Model files ready. Notebook inference can now run offline.", flush=True)


if __name__ == "__main__":
    main()
