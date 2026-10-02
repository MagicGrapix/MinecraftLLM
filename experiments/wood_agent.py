"""A Jev-only decision policy over a small, explicit simulated behavior graph.

No Minecraft connection, generated code, action imports from the parent project,
or generative model. World mechanics and inventory requirements are Python code.
"""
from __future__ import annotations

import copy
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

LOG_ITEMS = frozenset(f"{species}_log" for species in
                      ("oak", "spruce", "birch", "jungle", "acacia", "dark_oak",
                       "mangrove", "cherry", "pale_oak"))

ACTIONS = {
    "search_tree": "Look for a tree with remaining log blocks; select it or explore farther.",
    "approach_tree": "Move closer to the selected tree so its log blocks can be reached.",
    "chop_log": "Break ONE reachable log block. It drops an item on the ground; inventory does not increase yet.",
    "collect_logs": "Pick up nearby dropped log items. This increases the inventory count.",
    "wait": "Do nothing this step. Only useful if waiting is actually necessary.",
    "stop": "Stop gathering because the required inventory count has already been reached.",
}


def count_logs(inventory):
    """Count supported overworld log items; planks and other items do not count."""
    return sum(count for item, count in inventory.items() if item in LOG_ITEMS)


@dataclass(frozen=True)
class WoodRequirement:
    quantity: int = 10
    mode: str = "collect_new"
    baseline_logs: int = 0

    def __post_init__(self):
        if type(self.quantity) is not int or self.quantity < 0:
            raise ValueError("quantity must be a nonnegative integer")
        if type(self.baseline_logs) is not int or self.baseline_logs < 0:
            raise ValueError("baseline_logs must be a nonnegative integer")
        if self.mode not in ("collect_new", "inventory_total"):
            raise ValueError("Use collect_new or inventory_total")

    @property
    def target_total(self):
        return self.quantity + (self.baseline_logs if self.mode == "collect_new" else 0)

    def satisfied(self, inventory):
        return count_logs(inventory) >= self.target_total


@dataclass
class Tree:
    x: int
    logs: int = 5


@dataclass
class SimulatedWorld:
    """One-dimensional toy world; search/move/chop/pickup are atomic skills.

    No Minecraft physics, ticks, pathfinding, mobs or network timings are modeled.
    Only inventory changes, tree depletion and reachability are represented.
    """
    inventory: dict = field(default_factory=dict)
    trees: list = field(default_factory=lambda: [Tree(4, 5), Tree(12, 5), Tree(20, 5)])
    position: int = 0
    selected_tree: int | None = None
    dropped_logs: dict = field(default_factory=dict)
    last_action: str = "none"
    last_effect: str = "Task just started."
    steps: int = 0

    def __post_init__(self):
        self.inventory = copy.deepcopy(self.inventory)
        self.trees = copy.deepcopy(self.trees)
        self.dropped_logs = copy.deepcopy(self.dropped_logs)
        if any(type(n) is not int or n < 0 for n in self.inventory.values()):
            raise ValueError("Inventory counts must be nonnegative integers")
        if any(tree.logs < 0 for tree in self.trees):
            raise ValueError("Tree counts must be nonnegative")

    def target(self):
        if self.selected_tree is None:
            return None
        tree = self.trees[self.selected_tree]
        return tree if tree.logs > 0 else None

    def nearby_drops(self):
        return sum(n for x, n in self.dropped_logs.items() if abs(x - self.position) <= 2)

    def observe(self, requirement):
        tree = self.target()
        visible = [{"distance": abs(t.x - self.position), "remaining_logs": t.logs,
                    "selected": i == self.selected_tree}
                   for i, t in enumerate(self.trees)
                   if t.logs > 0 and abs(t.x - self.position) <= 6]
        return {
            "task": f"Obtain {requirement.quantity} " +
                    ("NEW logs beyond the starting inventory." if requirement.mode == "collect_new"
                     else "logs in total in the inventory."),
            "required_inventory_logs": requirement.target_total,
            "starting_inventory_logs": requirement.baseline_logs,
            "inventory": dict(self.inventory), "inventory_logs": count_logs(self.inventory),
            "remaining_logs_to_collect": max(0, requirement.target_total - count_logs(self.inventory)),
            "selected_tree_distance": abs(tree.x - self.position) if tree else None,
            "selected_tree_remaining_logs": tree.logs if tree else 0,
            "visible_trees": visible,
            "nearby_dropped_log_items": self.nearby_drops(),
            "world_changes_without_actions": False,
            "last_action": self.last_action, "last_effect": self.last_effect,
        }

    def available_actions(self):
        tree = self.target()
        legal = {}
        if tree is None and any(tree.logs > 0 for tree in self.trees):
            legal["search_tree"] = ACTIONS["search_tree"]
        if tree and abs(tree.x - self.position) > 2:
            legal["approach_tree"] = ACTIONS["approach_tree"]
        if tree and abs(tree.x - self.position) <= 2:
            legal["chop_log"] = ACTIONS["chop_log"]
        if self.nearby_drops() > 0:
            legal["collect_logs"] = ACTIONS["collect_logs"]
        # Retrieval of remote dropped items is part of exploring if no trees remain.
        if tree is None and not legal and any(self.dropped_logs.values()):
            legal["search_tree"] = ACTIONS["search_tree"]
        legal["wait"] = ACTIONS["wait"]
        return legal

    def execute(self, action):
        """Validate before mutating; illegal model choices never change the world."""
        if action not in self.available_actions():
            return {"valid": False, "effect": f"Precondition failed for {action}."}
        self.steps += 1
        tree = self.target()
        if action == "search_tree":
            choices = [(i, t) for i, t in enumerate(self.trees) if t.logs > 0]
            if choices:
                i, nearest = min(choices, key=lambda pair: abs(pair[1].x - self.position))
                if abs(nearest.x - self.position) <= 6:
                    self.selected_tree = i
                    effect = "Selected a visible tree; it is not necessarily reachable yet."
                else:
                    self.position += 3 if nearest.x > self.position else -3
                    effect = "Explored three blocks toward the wooded area."
            else:
                x = min((x for x, n in self.dropped_logs.items() if n),
                        key=lambda x: abs(x - self.position))
                self.position = x
                effect = "Approached remaining dropped items."
        elif action == "approach_tree":
            self.position = tree.x - 1
            effect = "Reached the selected tree."
        elif action == "chop_log":
            tree.logs -= 1
            self.dropped_logs[tree.x] = self.dropped_logs.get(tree.x, 0) + 1
            effect = "Broke one log. It is on the ground, not in the inventory."
            if tree.logs == 0:
                self.selected_tree = None
        elif action == "collect_logs":
            taken = self.nearby_drops()
            for x in list(self.dropped_logs):
                if abs(x - self.position) <= 2:
                    del self.dropped_logs[x]
            self.inventory["oak_log"] = self.inventory.get("oak_log", 0) + taken
            effect = f"Picked up {taken} log item(s)."
        else:
            effect = "Waited; the simulated world did not change."
        self.last_action, self.last_effect = action, effect
        return {"valid": True, "effect": effect}


def compact_state(state):
    """Render the same observations in short text; no preferred action is added."""
    visible = "; ".join(f"{tree['remaining_logs']} logs, {tree['distance']} blocks away"
                        for tree in state["visible_trees"]) or "none"
    return (
        f"Minecraft task: {state['task']}\n"
        f"Inventory now: {state['inventory_logs']} logs. Required inventory: "
        f"{state['required_inventory_logs']} logs. Still needed: {state['remaining_logs_to_collect']}.\n"
        f"Visible trees: {visible}.\n"
        f"Selected tree: distance {state['selected_tree_distance']}, "
        f"remaining log blocks {state['selected_tree_remaining_logs']}.\n"
        f"Dropped logs within pickup reach: {state['nearby_dropped_log_items']}.\n"
        f"Automatic changes while waiting: none.\n"
        f"Last action: {state['last_action']}. Result: {state['last_effect']}"
    )


def jev_policy(lab, state_format="json"):
    if state_format not in ("json", "compact_text"):
        raise ValueError("Use json or compact_text")
    def select(state, candidates):
        observed = compact_state(state) if state_format == "compact_text" else state
        result = lab.decide(observed, {"next_action": {
            "type": "choice",
            "instructions": "Choose the next executable action to satisfy the inventory requirement. "
                            "Logs on the ground do NOT count as inventory. Use the reported state; "
                            "do not assume any inventory change that has not happened.",
            "criteria": candidates,
        }})
        answer = result["answers"]["next_action"]
        return {"action": answer["choice"], "probabilities": answer["probabilities"],
                "model_ms": result["meta"]["elapsed_ms"],
                "input_tokens": result["meta"]["input_tokens"], "source": "jev"}
    return select


def baseline_policy(state, candidates):
    """Simple hand-written comparison, explicitly not a Jev decision."""
    priority = ("collect_logs", "chop_log", "approach_tree", "search_tree", "wait")
    chosen = next(action for action in priority if action in candidates)
    return {"action": chosen, "probabilities": {}, "model_ms": 0, "input_tokens": 0,
            "source": "fixed_rule"}


def run_episode(world, policy, quantity=10, mode="collect_new", max_steps=48,
                no_progress_limit=6, mask_preconditions=True, include_wait=False,
                skip_single_choice=True):
    """Stop before any next decision once the actual inventory satisfies the goal."""
    if max_steps < 1 or no_progress_limit < 1:
        raise ValueError("Positive episode limits required")
    requirement = WoodRequirement(quantity, mode, count_logs(world.inventory))
    trace, stalled = [], 0
    status = "step_limit"
    initial_log_blocks = sum(tree.logs for tree in world.trees)
    start = time.perf_counter()
    for step in range(max_steps):
        state = world.observe(requirement)
        if requirement.satisfied(world.inventory):
            status = "success"
            break
        legal = world.available_actions()
        if not include_wait:
            legal = {name: description for name, description in legal.items() if name != "wait"}
        if not legal or list(legal) == ["wait"]:
            status = "no_resources"
            break
        candidates = legal if mask_preconditions else dict(ACTIONS)
        if skip_single_choice and len(candidates) == 1:
            decision = {"action": next(iter(candidates)), "probabilities": {},
                        "model_ms": 0, "input_tokens": 0, "source": "sole_legal_action"}
        else:
            decision = policy(state, candidates)
        action = decision["action"]
        if action not in candidates:
            raise ValueError("Policy returned an action outside the proposed choices")
        before_world = (world.position, count_logs(world.inventory),
                        sum(t.logs for t in world.trees), sum(world.dropped_logs.values()),
                        world.selected_tree)
        effect = world.execute(action)
        after_world = (world.position, count_logs(world.inventory),
                       sum(t.logs for t in world.trees), sum(world.dropped_logs.values()),
                       world.selected_tree)
        stalled = stalled + 1 if before_world == after_world else 0
        met = requirement.satisfied(world.inventory)
        trace.append({
            "step": step, "inventory_before": state["inventory_logs"],
            "inventory_after": count_logs(world.inventory),
            "ground_logs_before": state["nearby_dropped_log_items"],
            "tree_distance_before": state["selected_tree_distance"],
            "candidates": list(candidates), "selected": action,
            "probabilities": decision["probabilities"], "valid": effect["valid"],
            "decision_source": decision.get("source", "policy"),
            "effect": effect["effect"], "model_ms": decision["model_ms"],
            "input_tokens": decision["input_tokens"], "goal_met_after": met,
        })
        if met:
            status = "success"
            break
        if stalled >= no_progress_limit:
            status = "no_progress"
            break
    success = requirement.satisfied(world.inventory)
    return {
        "status": status, "success": success, "quantity": quantity, "mode": mode,
        "starting_logs": requirement.baseline_logs, "required_total": requirement.target_total,
        "final_logs": count_logs(world.inventory), "decisions": len(trace),
        "model_calls": sum(bool(row["probabilities"]) for row in trace),
        "forced_transitions": sum(row["decision_source"] == "sole_legal_action" for row in trace),
        "invalid_choices": sum(not row["valid"] for row in trace),
        "model_total_ms": round(sum(row["model_ms"] for row in trace), 2),
        "wall_ms": round((time.perf_counter() - start) * 1000, 2),
        "stop_reason": "inventory_requirement" if success else status,
        "masked_preconditions": mask_preconditions, "trace": trace,
        "include_wait": include_wait, "skip_single_choice": skip_single_choice,
        "log_blocks_broken": initial_log_blocks - sum(tree.logs for tree in world.trees),
        "ground_logs_remaining": sum(world.dropped_logs.values()),
        "simulation": "toy 1D world, atomic skills; no Minecraft physics or server",
    }


def stopping_probes(lab, counts=(0, 9, 10, 11), target=10):
    """Ask Jev about stopping, but never use its answer as the completion check."""
    rows = []
    for count in counts:
        world = SimulatedWorld(inventory={"oak_log": count}, selected_tree=0, position=3)
        requirement = WoodRequirement(target, "inventory_total", count)
        state = world.observe(requirement)
        result = lab.decide(state, {
            "next_action": {"type": "choice",
                            "instructions": "Which action should be performed next to meet the inventory goal?",
                            "criteria": dict(ACTIONS)},
            "done": {"type": "noul", "instructions": "Is the required inventory count already reached?"},
        })
        answer = result["answers"]["next_action"]
        rows.append({
            "inventory_logs": count, "target": target,
            "deterministic_done": requirement.satisfied(world.inventory),
            "jev_selected": answer["choice"],
            "jev_stop_probability": round(answer["probabilities"]["stop"], 4),
            "jev_done_probability": round(result["answers"]["done"]["noul"], 4),
            "elapsed_ms": result["meta"]["elapsed_ms"],
        })
    return rows


def save_episode(result, prefix="wood_agent"):
    folder = Path(__file__).resolve().parent / "runs"
    folder.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = folder / f"{prefix}_{stamp}.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path
