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
  blueprintsDirectory?: string,
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  register(registry, new BuildCapability(blueprintsDirectory),
    "Does: Build or resume a saved blueprint at a fixed origin; add and remove short exterior dirt stairs when needed.\nSuccess: Required blocks, air and door states were observed correct; the bot left the footprint and its tracked scaffolding was removed. Does not prove habitability or dirt-drop pickup.\nLimits: Requires flat full-block ground including a two-block margin, a loaded site within 50 blocks, all remaining materials and up to 24 extra dirt for access. No gathering, crafting or terrain clearing. Doors must match their expected states; conflicting blocks are not replaced.\nNotes: Up to 300 seconds. Failure or stop may leave a partial structure and tracked dirt. Reuse blueprintId and origin in the same bot session to resume construction/cleanup. Scaffolding is reported separately and never spends dirt reserved for the blueprint.");
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
    "Does: Place the held block against a reference block's selected face.\nSuccess: An inbound server update confirmed the expected block at the returned position.\nLimits: Does not verify orientation or a complete structure. Only items with a matching block ID are supported.\nNotes: Equip the intended block first. The destination is adjacent to referencePosition. On ACTION_NOT_CONFIRMED, inspect it before retrying; the placement may still take effect.",
  );
  register(
    registry,
    new DropCapability(),
    "Drop a requested inventory item quantity or clear matching stacks.",
  );
  register(
    registry,
    new CraftFromInventoryCapability(),
    "Does: Craft an item using the bot's 2x2 inventory grid.\nSuccess: Server inventory confirmed each recipe's output and ingredients, with empty crafting grid and cursor.\nLimits: Cannot make recipes requiring a 3x3 grid; does not craft missing ingredients automatically.\nNotes: quantity is minimum output, not recipe repetitions. Whole batches may produce extra items; read craftedQuantity. On ACTION_NOT_CONFIRMED, inspect inventory before retrying: some items may already exist. One log makes four planks; two planks make four sticks.",
  );
  register(
    registry,
    new CraftFromTableCapability(),
    "Does: Craft an item at an existing reachable crafting table using its 3x3 grid. Also supports 2x2 recipes.\nSuccess: Server inventory confirmed each recipe's output and ingredients; the grid/cursor are empty and the table remained unchanged.\nLimits: Does not find, approach or place a table; does not craft missing ingredients automatically.\nNotes: Supply the table's observed integer tablePosition. quantity is minimum output, not recipe repetitions. Whole batches may produce extra items; read craftedQuantity. On ACTION_NOT_CONFIRMED, inspect inventory before retrying.",
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
