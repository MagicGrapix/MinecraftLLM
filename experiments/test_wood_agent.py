"""Behavioral invariants independent of model quality; no weights loaded."""
import unittest

from wood_agent import (SimulatedWorld, Tree, WoodRequirement, baseline_policy,
                        count_logs, run_episode)


class RequirementsAndExecution(unittest.TestCase):
    def test_new_logs_are_relative_to_starting_inventory(self):
        result = run_episode(SimulatedWorld(inventory={"oak_log": 3}), baseline_policy, 10)
        self.assertTrue(result["success"])
        self.assertEqual(result["required_total"], 13)
        self.assertEqual(result["final_logs"], 13)
        self.assertEqual(result["trace"][-1]["selected"], "collect_logs")

    def test_completion_skips_policy_and_all_actions(self):
        def forbidden(*args):
            raise AssertionError("No model decision is allowed after completion")
        world = SimulatedWorld(inventory={"birch_log": 10, "oak_planks": 64})
        result = run_episode(world, forbidden, 10, mode="inventory_total")
        self.assertTrue(result["success"])
        self.assertEqual(result["decisions"], 0)
        self.assertEqual(world.steps, 0)

    def test_ground_items_do_not_satisfy_inventory_requirement(self):
        world = SimulatedWorld(position=3, selected_tree=0)
        self.assertTrue(world.execute("chop_log")["valid"])
        self.assertFalse(WoodRequirement(1).satisfied(world.inventory))
        self.assertEqual(world.nearby_drops(), 1)
        world.execute("collect_logs")
        self.assertTrue(WoodRequirement(1).satisfied(world.inventory))

    def test_early_model_stop_is_rejected(self):
        def stop(*args):
            return {"action": "stop", "probabilities": {"stop": 1.0},
                    "model_ms": 1, "input_tokens": 1}
        world = SimulatedWorld()
        result = run_episode(world, stop, 10, mask_preconditions=False, no_progress_limit=2)
        self.assertFalse(result["success"])
        self.assertEqual(result["status"], "no_progress")
        self.assertEqual(result["invalid_choices"], 2)
        self.assertEqual(world.inventory, {})
        self.assertEqual(world.steps, 0)

    def test_finite_resources_cannot_be_reported_as_success(self):
        result = run_episode(SimulatedWorld(trees=[Tree(4, 2)]), baseline_policy, 3)
        self.assertFalse(result["success"])
        self.assertEqual(result["status"], "no_resources")
        self.assertEqual(result["final_logs"], 2)

    def test_waiting_is_bounded(self):
        def wait(*args):
            return {"action": "wait", "probabilities": {"wait": 1.0},
                    "model_ms": 1, "input_tokens": 1}
        result = run_episode(SimulatedWorld(), wait, no_progress_limit=3)
        self.assertEqual(result["status"], "no_progress")
        self.assertEqual(result["decisions"], 3)

    def test_wrong_items_do_not_count_and_multiple_species_do(self):
        self.assertEqual(count_logs({"oak_planks": 64, "stick": 16}), 0)
        self.assertEqual(count_logs({"oak_log": 2, "birch_log": 3, "stick": 16}), 5)

    def test_illegal_chopping_cannot_mutate_distant_tree(self):
        world = SimulatedWorld(selected_tree=1)
        before = world.trees[1].logs
        self.assertFalse(world.execute("chop_log")["valid"])
        self.assertEqual(world.trees[1].logs, before)
        self.assertEqual(world.dropped_logs, {})


if __name__ == "__main__":
    unittest.main()
