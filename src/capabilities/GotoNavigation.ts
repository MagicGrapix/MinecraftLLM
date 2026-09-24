import type { Bot } from "mineflayer";
import type { PartiallyComputedPath } from "mineflayer-pathfinder";
import { goals } from "mineflayer-pathfinder";

// The library's goto() resolves on any empty path_update, including a
// still-running "partial" search. Wait for a final verdict instead.
export function navigateToGoal(bot: Bot, goal: goals.Goal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      bot.removeListener("goal_reached", onGoalReached);
      bot.removeListener("path_update", onPathUpdate);
      bot.removeListener("goal_updated", onGoalUpdated);
      bot.removeListener("path_stop", onPathStop);
      if (
        error &&
        error.name !== "GoalChanged" &&
        error.name !== "PathStopped"
      ) {
        bot.pathfinder.stop();
      }
      // Let pathfinder finish its event handler before another goal starts.
      setTimeout(() => (error ? reject(error) : resolve()), 0);
    };

    const onGoalReached = (reached: goals.Goal): void => {
      if (reached === goal) finish();
    };
    const onPathUpdate = (update: PartiallyComputedPath): void => {
      if (update.status === "noPath") {
        finish(pathError("NoPath", "No path to the goal!"));
      } else if (update.status === "timeout") {
        finish(
          pathError("Timeout", "Took too long to decide a path to the goal!"),
        );
      }
    };
    const onGoalUpdated = (updated: goals.Goal): void => {
      if (updated !== goal) {
        finish(pathError("GoalChanged", "The navigation goal changed."));
      }
    };
    const onPathStop = (): void => {
      finish(pathError("PathStopped", "Pathfinder stopped before the goal."));
    };

    bot.on("goal_reached", onGoalReached);
    bot.on("path_update", onPathUpdate);
    bot.on("goal_updated", onGoalUpdated);
    bot.on("path_stop", onPathStop);
    try {
      bot.pathfinder.setGoal(goal);
    } catch (error: unknown) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function pathError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
