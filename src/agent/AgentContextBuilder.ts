import type { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import type {
  ExecutionController,
  ExecutionSnapshot,
} from "../execution/ExecutionController";
import type { LLMMessage } from "../llm/LLMClient";
import type { ConversationHistory } from "../memory/ConversationHistory";
import type { LandmarkMemory } from "../memory/LandmarkMemory";
import type { RecentActivityBuffer } from "../memory/RecentActivityBuffer";
import type { PromptTemplate } from "../prompts/PromptTemplate";
import type { LoadedSkill } from "../skills/Skill";
import type { SkillRegistry } from "../skills/SkillRegistry";
import type { WorldQueries } from "../world/WorldQueries";
import type { WorldQueryRegistry } from "../world/queries/WorldQueryRegistry";
import type { AgentPermissionMode } from "./AgentToolBridge";

export interface AgentContextRequest {
  readonly manualStopped: boolean;
  readonly permission: AgentPermissionMode;
  readonly generationId: number;
  readonly wakeReason: string;
  readonly activeDirective: string | null;
  readonly currentInput: string;
  readonly loadedSkills?: readonly LoadedSkill[];
}

export class AgentContextBuilder {
  constructor(
    private readonly dependencies: {
      world: WorldQueries;
      controller: ExecutionController;
      capabilities: CapabilityRegistry;
      queries: WorldQueryRegistry;
      skills: SkillRegistry;
      landmarks: LandmarkMemory;
      activities: RecentActivityBuffer;
      history: ConversationHistory;
      systemPrompt: PromptTemplate;
      budgetChars: number;
    },
  ) {}

  build(request: AgentContextRequest): readonly LLMMessage[] {
    const mandatory = {
      runtime: {
        manualStopped: request.manualStopped,
        permission: request.permission,
        generationId: request.generationId,
        wakeReason: request.wakeReason,
      },
      directive: request.activeDirective,
      execution: compactSnapshot(
        this.dependencies.controller.snapshot(),
      ),
      self: this.dependencies.world.getSelf(),
      inventory: this.dependencies.world.getInventory(),
      pinnedLandmarks: this.dependencies.landmarks.pinned(),
      capabilities: this.dependencies.capabilities.list(),
      queries: this.dependencies.queries.list(),
      skills: this.dependencies.skills.list(),
      loadedSkills: request.loadedSkills ?? [],
    };
    const userMessage: LLMMessage = {
      role: "user",
      content: request.currentInput,
    };
    const renderSystem = (recentActivity: unknown): string =>
      this.dependencies.systemPrompt.render({
        current_context: JSON.stringify(mandatory),
        recent_activity: JSON.stringify(recentActivity),
      });
    const baseSystem = renderSystem([]);

    let used =
      baseSystem.length + JSON.stringify(userMessage).length;
    const selectedActivities = [];
    const activities = [...this.dependencies.activities.list()].reverse();
    for (const activity of activities) {
      const cost = JSON.stringify(activity).length;
      if (used + cost > this.dependencies.budgetChars) break;
      selectedActivities.unshift(activity);
      used += cost;
    }

    const selectedGroups: (readonly LLMMessage[])[] = [];
    const groups = [...this.dependencies.history.groups()].reverse();
    for (const group of groups) {
      const cost = JSON.stringify(group).length;
      if (used + cost > this.dependencies.budgetChars) break;
      selectedGroups.unshift(group);
      used += cost;
    }

    const system: LLMMessage = {
      role: "system",
      content: renderSystem(selectedActivities),
    };
    const messages: LLMMessage[] = [
      system,
      ...selectedGroups.flatMap((group) => group),
      userMessage,
    ];
    console.debug("Agent context assembled.", {
      generationId: request.generationId,
      permission: request.permission,
      wakeReason: request.wakeReason,
      executionRevision: mandatory.execution.revision,
      executionMode: mandatory.execution.mode,
      pendingTasks: mandatory.execution.pending.length,
      hasCurrentTask: mandatory.execution.current !== null,
      pinnedLandmarks: mandatory.pinnedLandmarks.length,
      selectedActivities: selectedActivities.length,
      selectedHistoryGroups: selectedGroups.length,
      messageCount: messages.length,
      contextChars: JSON.stringify(messages).length,
      budgetChars: this.dependencies.budgetChars,
    });
    return messages;
  }
}

function compactSnapshot(snapshot: ExecutionSnapshot) {
  return {
    revision: snapshot.revision,
    mode: snapshot.mode,
    current: snapshot.current,
    pending: snapshot.pending,
    shutdown: snapshot.shutdown,
  };
}
