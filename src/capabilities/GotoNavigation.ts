import type { Bot } from "mineflayer";
import type { PartiallyComputedPath } from "mineflayer-pathfinder";
import { goals } from "mineflayer-pathfinder";

// The library's goto() resolves on any empty path_update, including a
// still-running "partial" search. Wait for a final verdict instead.
export function navigateToGoal(bot: Bot, goal: goals.Goal, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      bot.removeListener("goal_reached", onGoalReached);
      bot.removeListener("path_update", onPathUpdate);
      bot.removeListener("goal_updated", onGoalUpdated);
      bot.removeListener("path_stop", onPathStop);
      bot.removeListener("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      // Let pathfinder finish its event handler before another goal starts.
      setTimeout(() => {
        // stop() leaves a deferred stop flag that can stop the NEXT goto.
        // Clear the failed goal after pathfinder finishes handling path_update.
        if (error && error.name !== "GoalChanged") bot.pathfinder.setGoal(null);
        if (error) reject(error);
        else resolve();
      }, 0);
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
    const onAbort = (): void => {
      finish(pathError("AbortError", "Navigation interrupted."));
    };
    const onEnd = (): void => {
      finish(pathError("ConnectionEnded", "Minecraft connection ended during navigation."));
    };

    bot.on("goal_reached", onGoalReached);
    bot.on("path_update", onPathUpdate);
    bot.on("goal_updated", onGoalUpdated);
    bot.on("path_stop", onPathStop);
    bot.on("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
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

export function waitForNavigationLanding(bot: Bot, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (hasStableSupport(bot)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      bot.removeListener("physicsTick", onTick);
      bot.removeListener("end", onEnd);
      signal.removeEventListener("abort", onAbort);
    };
    const onTick = (): void => {
      if (!hasStableSupport(bot)) return;
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(pathError("AbortError", "Navigation interrupted before landing."));
    };
    const onEnd = (): void => {
      cleanup();
      reject(pathError("ConnectionEnded", "Minecraft connection ended before landing."));
    };
    bot.on("physicsTick", onTick);
    bot.on("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function hasStableSupport(bot: Bot): boolean {
  // Mineflayer physics supplies isInWater, but Entity's declarations omit it.
  const entity = bot.entity as Bot["entity"] & { isInWater?: boolean };
  return entity.onGround || entity.isInWater === true;
}
