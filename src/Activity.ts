
// I see two ways LLM could interact.
// 1. by choosing actions like goto, collect directly
//      + fine grained emergent narrative
//      - LLM reasonning can be bad
// 2. by choosing activities
//      + more consistent and stable
//      - less generative


// Activities:
//- Explore() <-- LLM advanced
//- ImagineBuild() <-- LLM advanced
//- Collect
//- Gather(item[] | Reciepe(item), count)
//  while not enough:
//    - Goto(Locate(item))
//    - Collect()
//- Craft3x3(item)
//  - Gather(Reciepe(item))?
//  - Craft2x2(WorkBench)
//  - Goto(WorkBench)
//  - Use(WorkBench)


// Unit Bot Actions
// - Build(Structure)
// - Place block(Position)
// - Break block(Position)
// - Goto(Position | Locate(item | entity))
// - DigBlock(Position | Locate(item | entity))
// - Equip(item)
// - Drop(item)
// - PickUp(Position | Locate(item | entity))
// (- UseItem(item, Position | entity))
// - Craft2x2(item)

// ActionsObjects
// Entity -> anything living
// Item -> an item of the game
// Position: {x, y, z}
// Locate(item | entity) -> get Position of item or entity
// Structure




// I think I should name Action the assembly of many Action steps (such as chopping wood)
// it can succeed (need feedback) => LLM 

import { Action, BotManager } from "BotManager";

// it can fail (logic, timeout, infeasible) => LLM
export abstract class Activity {
  protected manager: BotManager;

  constructor(_manager: BotManager) {
    this.manager = _manager;
  }

  public next(): Action {
    throw new Error('NYI');
  }
}