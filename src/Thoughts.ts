import { BotManager } from "./BotManager";


// A praticular reflexion about something
export class Thought {

  // origin -> reflexion -> outcome
  // context

  // I think it will be great to differentiate different thoughts
  // PlanningThoughts (which high level Action)
  // EvaluationThoughts (was this good or bad?)
  // DecisionThoughts (choose a specific sequence of ActionSteps leading to an Action)

}


// Chain of many thoughts leading to an outcome
export class ThoughtProcess {

  // origin thought -> ... -> final thought = action
}


// manages different chains of thoughts
export class ThoughtsManager {

  public constructor(botManager: BotManager) {
    // init openai
  }


}