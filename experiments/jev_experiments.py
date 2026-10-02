"""CPU measurements for the pinned local Jev model; no game connection."""
from __future__ import annotations

import csv
import html
import json
import os
import platform
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import psutil
import torch

ROOT = Path(__file__).resolve().parent


def request_profile(lab, state, questions):
    """Count exactly the same rendered, chat-wrapped inputs as the runtime."""
    from jev08.api import candidate_prompts, compile_request

    rows = []
    for record in compile_request(state, questions):
        prompts = [lab.model.wrap_chat(p) for p in candidate_prompts(record)]
        tokens = lab.model.tokenizer(prompts, padding=False, truncation=False)["input_ids"]
        lengths = [len(ids) for ids in tokens]
        rows.append({
            "question_id": record["id"], "type": record["kind"],
            "candidate_prompts": len(lengths), "token_lengths": lengths,
            "input_tokens": sum(lengths), "longest_prompt_tokens": max(lengths),
            "padded_tokens": max(lengths) * len(lengths),
        })
    longest = max(row["longest_prompt_tokens"] for row in rows)
    return {
        "questions": rows, "question_count": len(rows),
        "candidate_prompts": sum(row["candidate_prompts"] for row in rows),
        "input_tokens": sum(row["input_tokens"] for row in rows),
        "padded_tokens": sum(row["padded_tokens"] for row in rows),
        "longest_prompt_tokens": longest, "max_length": lab.max_length,
        "within_limit": longest <= lab.max_length,
    }


def machine_info():
    cpu_name = platform.processor()
    if sys.platform == "win32":
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
            cpu_name = winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
    return {
        "cpu": cpu_name, "logical_cpus": os.cpu_count(),
        "physical_cpus": psutil.cpu_count(logical=False),
        "ram_gib": round(psutil.virtual_memory().total / 2**30, 2),
        "python": platform.python_version(), "torch": torch.__version__,
        "threads": torch.get_num_threads(), "dtype": "float32",
        "device": "cpu", "model": "guoan1/jev-qwen35-08b",
        "adapter_revision": "62986e6dce924fff167dea9d7469b01f9e7e7ff2",
        "base_revision": "dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68",
        "local_time": datetime.now().astimezone().isoformat(),
        "utc_time": datetime.now(timezone.utc).isoformat(),
    }


_CANDIDATES = {
    "search": "Search nearby terrain for a tree that can supply logs.",
    "chop": "Break one reachable log block on the selected tree.",
    "pickup": "Pick up dropped log items close to the player.",
    "approach": "Walk toward the selected tree until it is reachable.",
    "wait": "Stay still and wait for the world to change.",
    "stop": "End the task because the inventory goal has been met.",
    "flee": "Move away from an immediate threat before continuing.",
    "eat": "Eat food to restore hunger before continuing.",
}


def make_request(lab, token_budget=256, candidates=4, kind="choice"):
    """Fit the longest real candidate input to a token budget, without truncation.

    Padding is inert synthetic text, useful for timing, not for quality testing.
    """
    if kind not in ("choice", "noul"):
        raise ValueError("Use choice or noul")
    if kind == "choice" and not 1 <= candidates <= len(_CANDIDATES):
        raise ValueError("Use 1 through 8 candidates in this benchmark")
    if kind == "choice":
        questions = {"next": {
            "type": "choice", "instructions": "Choose the next action to obtain the requested logs.",
            "criteria": dict(list(_CANDIDATES.items())[:candidates]),
        }}
    else:
        questions = {"done": {
            "type": "noul", "instructions": "Has the inventory reached the required log count?",
        }}

    def build(n):
        return {"goal_logs": 10, "inventory_logs": 3, "tree_distance": 2,
                "notes": " neutral" * n}

    if request_profile(lab, build(0), questions)["longest_prompt_tokens"] > token_budget:
        raise ValueError("Token budget is smaller than the question template")
    low, high = 0, token_budget * 2 + 1
    while low + 1 < high:
        mid = (low + high) // 2
        if request_profile(lab, build(mid), questions)["longest_prompt_tokens"] <= token_budget:
            low = mid
        else:
            high = mid
    state = build(low)
    return state, questions, request_profile(lab, state, questions)


def measure_request(lab, state, questions, repetitions=5, warmups=1):
    if lab.device != "cpu":
        raise ValueError("This experiment must run on CPU")
    if repetitions < 1 or warmups < 0:
        raise ValueError("Use positive repetitions and nonnegative warmups")
    profile = request_profile(lab, state, questions)
    if not profile["within_limit"]:
        raise ValueError("Request exceeds the checkpoint token limit")
    for _ in range(warmups):
        lab.decide(state, questions)
    samples, runtime_samples = [], []
    for _ in range(repetitions):
        start = time.perf_counter()
        result = lab.decide(state, questions)
        samples.append((time.perf_counter() - start) * 1000)
        runtime_samples.append(result["meta"]["elapsed_ms"])
        if result["meta"]["input_tokens"] != profile["input_tokens"]:
            raise AssertionError("Token profile disagrees with actual inference")
    median = statistics.median(samples)
    return {
        "type": next(iter(questions.values()))["type"],
        "candidate_prompts": profile["candidate_prompts"],
        "longest_prompt_tokens": profile["longest_prompt_tokens"],
        "input_tokens": profile["input_tokens"], "padded_tokens": profile["padded_tokens"],
        "threads": torch.get_num_threads(), "repetitions": repetitions,
        "median_ms": round(median, 2), "min_ms": round(min(samples), 2),
        "max_ms": round(max(samples), 2), "mean_ms": round(statistics.mean(samples), 2),
        "requests_per_second": round(1000 / median, 3),
        "candidate_prompts_per_second": round(profile["candidate_prompts"] * 1000 / median, 3),
        "samples_ms": [round(v, 2) for v in samples],
        "runtime_samples_ms": runtime_samples,
    }


def thread_sweep(lab, thread_counts=(1, 2, 4, 8), repetitions=3):
    if lab.device != "cpu":
        raise ValueError("CPU required")
    original = torch.get_num_threads()
    state, questions, _ = make_request(lab, 256, 4)
    rows = []
    try:
        for count in thread_counts:
            if count > (os.cpu_count() or 1):
                continue
            torch.set_num_threads(count)
            row = measure_request(lab, state, questions, repetitions)
            rows.append(row)
            print(f"threads={count}: {row['median_ms']} ms", flush=True)
    finally:
        torch.set_num_threads(original)
    return rows


def run_cpu_benchmark(lab, token_budgets=(128, 256, 512, 768),
                      candidate_counts=(2, 4, 8), repetitions=5, include_noul=True):
    if lab.device != "cpu":
        raise ValueError("Create JevSandbox(device='cpu')")
    started = time.perf_counter()
    rows = []
    for budget in token_budgets:
        if budget > lab.max_length:
            raise ValueError("Budget exceeds the installed checkpoint limit")
        cases = [("choice", count) for count in candidate_counts]
        if include_noul:
            cases.insert(0, ("noul", 1))
        for kind, count in cases:
            state, questions, _ = make_request(lab, budget, count, kind)
            row = measure_request(lab, state, questions, repetitions)
            row["requested_token_budget"] = budget
            rows.append(row)
            print(f"{kind}, {row['candidate_prompts']} inputs x "
                  f"{row['longest_prompt_tokens']} tokens: "
                  f"{row['median_ms']} ms, {row['requests_per_second']} requests/s", flush=True)
    return {
        "machine": machine_info(), "model_load_seconds": round(lab.load_seconds, 3),
        "wall_seconds": round(time.perf_counter() - started, 3), "rows": rows,
        "method": {"repetitions": repetitions, "warmups_per_case": 1,
                   "timed": "sequential end-to-end decide(), including request compilation, "
                            "tokenization, forward pass, and response formatting",
                   "excluded": "model loading, request construction, game actions, concurrent traffic",
                   "state_padding": "synthetic neutral filler; latency study, not a quality benchmark",
                   "caveat": "small sample; shared workstation load can change results"},
    }


def save_benchmark(result):
    folder = ROOT / "runs"
    folder.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = folder / f"cpu_benchmark_{stamp}.json"
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (folder / "cpu_benchmark_latest.json").write_text(output.read_text(encoding="utf-8"), encoding="utf-8")
    csv_path = output.with_suffix(".csv")
    scalar_rows = [{k: v for k, v in row.items() if not isinstance(v, list)} for row in result["rows"]]
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(scalar_rows[0]))
        writer.writeheader()
        writer.writerows(scalar_rows)
    return output


def html_table(rows, columns):
    """Simple escaped display for notebooks, without pandas or extra packages."""
    header = "".join(f"<th>{html.escape(str(label))}</th>" for _, label in columns)
    body = []
    for row in rows:
        cells = []
        for key, _ in columns:
            value = row.get(key, "")
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            cells.append(f"<td>{html.escape(str(value))}</td>")
        body.append("<tr>" + "".join(cells) + "</tr>")
    return '<table style="border-collapse:collapse;text-align:left" border="1" cellpadding="6">' + \
        "<thead><tr>" + header + "</tr></thead><tbody>" + "".join(body) + "</tbody></table>"
