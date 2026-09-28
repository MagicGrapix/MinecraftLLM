import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentConfig } from "../agent/AgentConfig";
import { AgentContextBuilder } from "../agent/AgentContextBuilder";
import { AgentToolBridge } from "../agent/AgentToolBridge";
import { MemoryUpdater } from "../agent/MemoryUpdater";
import { SequentialAgent } from "../agent/SequentialAgent";
import { WorkingMemory } from "../agent/WorkingMemory";
import { GotoCapability } from "../capabilities/Goto";
import { DigCapability } from "../capabilities/Dig";
import { EquipCapability } from "../capabilities/Equip";
import { PlaceCapability } from "../capabilities/Place";
import type { Capability } from "../capabilities/Capability";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { ChatIntentRouter } from "../chat/ChatIntentRouter";
import { AgentInspector } from "../debug/AgentInspector";
import { SequentialPlanRunner } from "../execution/SequentialPlanRunner";
import { OpenAICompatibleLLMClient } from "../llm/OpenAICompatibleLLMClient";
import { LandmarkMemory } from "../memory/LandmarkMemory";
import { loadAgentPrompts } from "../prompts/AgentPrompts";
import { SkillLoader } from "../skills/SkillLoader";
import { SkillRegistry } from "../skills/SkillRegistry";
import { createDefaultWorldQueryRegistry } from "../world/queries/defaultQueries";
import { LabExecutor } from "./LabExecutor";
import type { LabScenario } from "./LabScenario";
import { LabWorld } from "./LabWorld";

export interface LabReply {
  readonly at: number;
  readonly text: string;
}

export interface LabMessage extends LabReply {
  readonly role: "user" | "bot";
}

export class LabSession {
  readonly world: LabWorld;
  readonly executor: LabExecutor;
  readonly inspector: AgentInspector;
  readonly agent: SequentialAgent;
  readonly memory: WorkingMemory;
  readonly replies: LabReply[];
  readonly conversation: LabMessage[];

  private constructor(
    readonly scenario: LabScenario,
    world: LabWorld,
    executor: LabExecutor,
    inspector: AgentInspector,
    agent: SequentialAgent,
    memory: WorkingMemory,
    private readonly runner: SequentialPlanRunner,
    replies: LabReply[],
    conversation: LabMessage[],
  ) {
    this.world = world;
    this.executor = executor;
    this.inspector = inspector;
    this.agent = agent;
    this.memory = memory;
    this.replies = replies;
    this.conversation = conversation;
  }

  static async create(scenario: LabScenario, config: AgentConfig): Promise<LabSession> {
    const world = new LabWorld(scenario);
    const executor = new LabExecutor(world);
    const runner = new SequentialPlanRunner(executor);
    const inspector = new AgentInspector(Math.max(config.inspectorMaxRounds, 100));
    const capabilities = new CapabilityRegistry();
    register(capabilities, new GotoCapability(), "Move near an explicit position. Requires a path and does not alter blocks.");
    register(capabilities, new DigCapability(), "Break one explicit visible block by attacking it. The target must be reachable.");
    register(capabilities, new EquipCapability(), "Equip an inventory item into a requested hand or armor destination.");
    register(capabilities, new PlaceCapability(), "Place the equipped block against an explicit reference block and face.");
    const queries = createDefaultWorldQueryRegistry(world);
    const skills = await SkillRegistry.discover(resolve(process.cwd(), "skills"));
    const prompts = await loadAgentPrompts(resolve(process.cwd(), config.promptsDirectory));
    const landmarks = await LandmarkMemory.load(join(tmpdir(), `minecraft-lab-${randomUUID()}.json`));
    const memory = new WorkingMemory(config.memoryMaxChars);
    const llm = new OpenAICompatibleLLMClient({
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      requestTimeoutMs: config.llmRequestTimeoutMs,
      inspector,
    });
    const bridge = new AgentToolBridge({
      capabilities,
      queries,
      skills,
      skillLoader: new SkillLoader(skills, capabilities, queries),
      landmarks,
      currentDimension: () => "minecraft:overworld",
      isPositionLoaded: () => true,
    });
    const replies: LabReply[] = [];
    const conversation: LabMessage[] = [];
    const respond = async (text: string): Promise<void> => {
      const at = Date.now();
      replies.push({ at, text });
      conversation.push({ at, text, role: "bot" });
    };
    const agent = new SequentialAgent({
      llm,
      intentRouter: new ChatIntentRouter(llm, prompts.intentClassifier),
      contextBuilder: new AgentContextBuilder({
        world,
        landmarks,
        capabilities,
        systemPrompt: prompts.system,
      }),
      toolBridge: bridge,
      runner,
      workingMemory: memory,
      memoryUpdater: new MemoryUpdater({
        llm,
        prompt: prompts.memoryUpdate,
        memory,
        maxRetries: config.responseMaxRetries,
        maxTokens: config.llmMaxTokens,
        inspector,
        notifyRetry: respond,
      }),
      maxToolRounds: config.llmMaxToolRounds,
      maxResponseRetries: config.responseMaxRetries,
      temperature: config.llmTemperature,
      reasoningEffort: config.llmReasoningEffort,
      maxTokens: config.llmMaxTokens,
      inspector,
      respond,
    });
    return new LabSession(scenario, world, executor, inspector, agent, memory, runner, replies, conversation);
  }

  submitMessage(text: string): void {
    this.conversation.push({ at: Date.now(), text, role: "user" });
    this.agent.submitUserMessage("lab", text);
  }

  state(): unknown {
    return {
      sessionId: this.inspector.sessionId,
      scenario: this.scenario,
      world: this.world.snapshot(),
      agent: this.agent.state(),
      pendingTask: this.executor.pendingTask(),
      memory: this.memory.read(),
      replies: [...this.replies],
      conversation: [...this.conversation],
      rounds: this.inspector.listRounds(),
    };
  }

  async shutdown(): Promise<void> {
    await this.agent.shutdown();
    await this.runner.shutdown("Lab session reset.");
  }
}

function register<Input, Output>(
  registry: CapabilityRegistry,
  capability: Capability<Input, Output>,
  description: string,
): void {
  registry.register({
    name: capability.name,
    description,
    inputSchema: capability.inputSchema,
    execute: (input, context) => capability.execute(input, context),
  });
}
