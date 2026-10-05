import { AttackCapability } from "../capabilities/Attack";
import { BuildCapability } from "../capabilities/Build";
import type { Capability } from "../capabilities/Capability";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { CloseContainerCapability } from "../capabilities/CloseContainer";
import { ConsumeCapability } from "../capabilities/Consume";
import { CraftFromInventoryCapability, CraftFromTableCapability } from "../capabilities/Craft";
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
  register(registry, new BuildCapability(),
    "Does: Build or resume a saved blueprint of solid blocks and supported oak-door dependencies at a fixed origin.\nSuccess: Required blocks, air and both door halves were observed correct; the bot left the footprint. Does not prove habitability.\nLimits: No resource gathering, crafting, clearing or scaffolding. Requires flat full-block ground including a two-block margin, a loaded site within 50 blocks, and all remaining materials. Doors must be closed, unpowered and match the expected facing/hinge; conflicting doors are not replaced.\nNotes: Up to 300 seconds. Failure may leave a partial structure. Reuse blueprintId and origin to resume; never assume failure means nothing changed.");
  register(
    registry,
    new GotoCapability(),
    "Does: Move near a feet-level position, or approach a block with goal=interact.\nSuccess: The selected movement goal was reached.\nLimits: Does not verify digging conditions or loot pickup.\nNotes: canDig/canPlace may change terrain. Scaffolding uses inventory dirt or cobblestone.",
  );
  register(
    registry,
    new DigCapability(),
    "Does: Break one block at the specified position.\nSuccess: An inbound server block update confirmed removal at the target.\nLimits: Does not confirm that drops entered inventory. A client prediction without server confirmation is ACTION_NOT_CONFIRMED.\nNotes: Check get_block_access when uncertain. Observe the target before retrying an unconfirmed dig; check drops and inventory afterwards.",
  );
  register(
    registry,
    new EquipCapability(),
    "Equip an inventory item into a requested hand or armor destination.",
  );
  register(
    registry,
    new PlaceCapability(),
    "Does: Place the held block against a reference block's selected face.\nSuccess: The placement operation completed at the returned position.\nLimits: Does not verify a complete structure.\nNotes: Equip the intended block first. The destination is adjacent to referencePosition; inspect it with get_block.",
  );
  register(
    registry,
    new DropCapability(),
    "Drop a requested inventory item quantity or clear matching stacks.",
  );
  register(
    registry,
    new CraftFromInventoryCapability(),
    "Does: Craft an item using the bot's 2x2 inventory grid.\nSuccess: The requested output quantity was observed as gained in inventory.\nLimits: Cannot make recipes requiring a 3x3 grid; does not craft missing ingredients automatically.\nNotes: One log makes four planks; four planks make one crafting table. quantity is an output count, not recipe repetitions.",
  );
  register(
    registry,
    new CraftFromTableCapability(),
    "Does: Craft an item at an existing reachable crafting table using its 3x3 grid. Also supports 2x2 recipes.\nSuccess: The requested output quantity was observed as gained in inventory and the table remained unchanged.\nLimits: Does not find, approach or place a table; does not craft missing ingredients automatically.\nNotes: Supply the table's observed integer tablePosition. quantity is an output count, not recipe repetitions.",
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
    ...(capability.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: capability.defaultTimeoutMs }),
    execute: (input, context) => capability.execute(input, context),
  });
}
