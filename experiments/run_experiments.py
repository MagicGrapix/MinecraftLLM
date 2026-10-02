"""Reproduce the CPU benchmark and simulated episodes from experiments only."""
import argparse
import json
import time

import torch

from jev_sandbox import JevSandbox
from jev_experiments import run_cpu_benchmark, save_benchmark, thread_sweep
from wood_agent import (SimulatedWorld, Tree, baseline_policy, jev_policy,
                        run_episode, save_episode, stopping_probes)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--skip-benchmark", action="store_true")
    args = parser.parse_args()
    lab = JevSandbox(device="cpu")
    assert {str(p.device) for p in lab.model.parameters()} == {"cpu"}
    print(f"CPU float32 model loaded in {lab.load_seconds:.3f} s", flush=True)
    try:
        if not args.skip_benchmark:
            sweep = thread_sweep(lab)
            best = min(sweep, key=lambda row: row["median_ms"])
            torch.set_num_threads(best["threads"])
            print(f"Fixed CPU threads for the matrix: {best['threads']}", flush=True)
            measured = run_cpu_benchmark(lab, repetitions=args.repetitions)
            measured["thread_sweep"] = sweep
            measured["thread_selection"] = "Fastest of 1/2/4/8 on one 256-token, 4-choice " \
                "case; fixed thereafter. Not an exhaustive CPU optimization."
            saved = save_benchmark(measured)
            print(f"BENCHMARK_SAVED={saved}", flush=True)
        cases = [
            ("ten_new_logs", {}, 10, "collect_new", None),
            ("three_existing_plus_ten_new", {"oak_log": 3}, 10, "collect_new", None),
            ("already_complete", {"oak_log": 10}, 10, "inventory_total", None),
            ("not_enough_resources", {}, 3, "collect_new", [Tree(4, 2)]),
        ]
        results = []
        idle = run_episode(SimulatedWorld(), jev_policy(lab), 10,
                           include_wait=True, skip_single_choice=False)
        print("IDLE_ALLOWED=" + json.dumps({k: v for k, v in idle.items() if k != "trace"}), flush=True)
        for name, inventory, quantity, mode, trees in cases:
            config = {"inventory": inventory}
            if trees is not None:
                config["trees"] = trees
            baseline = run_episode(SimulatedWorld(**config), baseline_policy, quantity, mode)
            print(f"Running Jev episode: {name}", flush=True)
            started = time.perf_counter()
            episode = run_episode(SimulatedWorld(**config), jev_policy(lab), quantity, mode)
            results.append({"case": name, "jev": episode, "baseline": baseline})
            summary = {k: v for k, v in episode.items() if k != "trace"}
            print(json.dumps({"case": name, **summary}), flush=True)
        probes = stopping_probes(lab)
        print("STOPPING_PROBES=" + json.dumps(probes), flush=True)
        saved = save_episode({"device": "cpu", "threads": torch.get_num_threads(), "idle_allowed": idle,
                              "episodes": results, "stopping_probes": probes}, "wood_agent_validation")
        print(f"AGENT_RESULTS_SAVED={saved}", flush=True)
    finally:
        lab.close()


if __name__ == "__main__":
    main()
