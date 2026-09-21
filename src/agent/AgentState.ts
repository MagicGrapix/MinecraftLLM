export interface AgentRunState {
  readonly manualStopped: boolean;
  readonly activeDirective: string | null;
  readonly generationId: number;
  readonly thinking: boolean;
}
