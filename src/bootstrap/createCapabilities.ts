import { AttackCapability } from "../capabilities/Attack";
import type { Capability } from "../capabilities/Capability";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { CloseContainerCapability } from "../capabilities/CloseContainer";
import { ConsumeCapability } from "../capabilities/Consume";
import { CraftCapability } from "../capabilities/Craft";
import { DigCapability } from "../capabilities/Dig";
import { DropCapability } from "../capabilities/Drop";
import { EquipCapability } from "../capabilities/Equip";
import { GotoCapability } from "../capabilities/Goto";
import { InteractEntityCapability } from "../capabilities/InteractEntity";
import { OpenContainerCapability } from "../capabilities/OpenContainer";
import { PlaceCapability } from "../capabilities/Place";
import { TransferItemCapability } from "../capabilities/TransferItem";
import { UseBlockCapability } from "../capabilities/UseBlock";
import { UseItemCapability } from "../capabilities/UseItem";
import type { ContainerSessionManager } from "../runtime/ContainerSessionManager";

export function createCapabilityRegistry(
  sessions: ContainerSessionManager,
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  register(
    registry,
    new GotoCapability(),
    "Move near an explicit position. Requires a path and does not alter blocks.",
  );
  register(
    registry,
    new DigCapability(),
    "Break one explicit visible block by attacking it. The target must be reachable.",
  );
  register(
    registry,
    new EquipCapability(),
    "Equip an inventory item into a requested hand or armor destination.",
  );
  register(
    registry,
    new PlaceCapability(),
    "Place the equipped block against an explicit reference block and face.",
  );
  register(
    registry,
    new DropCapability(),
    "Drop a requested inventory item quantity or clear matching stacks.",
  );
  register(
    registry,
    new CraftCapability(),
    "Craft an item in the 2x2 inventory grid or at a reachable crafting table.",
  );
  register(
    registry,
    new ConsumeCapability(),
    "Consume the expected equipped food or drink and verify a server-side effect.",
  );
  register(
    registry,
    new UseItemCapability(),
    "Use the expected equipped item instantly or hold then release it.",
  );
  register(
    registry,
    new UseBlockCapability(),
    "Activate a simple explicit block such as a lever, button, or door.",
  );
  register(
    registry,
    new OpenContainerCapability(sessions),
    "Open a reachable chest-like block and create an opaque container session.",
  );
  register(
    registry,
    new TransferItemCapability(sessions),
    "Deposit or withdraw an exact item quantity through an active container session.",
  );
  register(
    registry,
    new CloseContainerCapability(sessions),
    "Close the active container session and its Minecraft window.",
  );
  register(
    registry,
    new AttackCapability(),
    "Attack one reachable visible entity by id and verify hurt, death, or disappearance.",
  );
  register(
    registry,
    new InteractEntityCapability(),
    "Right-click one reachable visible entity by id using the main hand.",
  );
  return registry;
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
