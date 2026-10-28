import { AttackCapability } from "../capabilities/Attack";
import { BuildCapability } from "../capabilities/Build";
import type { Capability } from "../capabilities/Capability";
import { CapabilityRegistry } from "../capabilities/CapabilityRegistry";
import { GetChestContentsCapability, UseChestCapability } from "../capabilities/Chest";
import { GetFurnaceContentsCapability, UseFurnaceCapability } from "../capabilities/Furnace";
import { ConsumeCapability } from "../capabilities/Consume";
import { CollectResourceCapability } from "../capabilities/CollectResource";
import { CraftFromInventoryCapability, CraftFromTableCapability } from "../capabilities/Craft";
import { DigCapability } from "../capabilities/Dig";
import { DropCapability } from "../capabilities/Drop";
import { EquipCapability } from "../capabilities/Equip";
import { GotoCapability } from "../capabilities/Goto";
import { InteractEntityCapability } from "../capabilities/InteractEntity";
import { PlaceCapability } from "../capabilities/Place";
import { UseBlockCapability } from "../capabilities/UseBlock";
import { UseItemCapability } from "../capabilities/UseItem";

export function createCapabilityRegistry(
  blueprintsDirectory?: string,
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  register(registry, new CollectResourceCapability(),
    'Does: Find, reach, mine and pick up additional logs, dirt, cobblestone, coal or raw_iron; try loose drops first. Coal/iron sources include normal and deepslate ores.\nSuccess: Server inventory confirmed at least quantity additional items since this call began.\nLimits: Mining coal requires a pickaxe; iron needs stone_pickaxe or another harvest-capable pickaxe (not wood/gold), without Silk Touch. No tool crafting or smelting. Loaded sources within 32 blocks; hard travel bound 50. Needs inventory space. Can clear local obstacles, maintain an 8-dirt reserve and place at most 24 supports on moderate terrain. No cliff/liquid crossing. Stops after bounded failures or 300 seconds.\nNotes: Request the dropped item, not the source block or an ingot. Read collected and inventoryKnown on partial failure before requesting the remainder. Scaffolds may remain; see scaffoldsLeft. Source removal alone is not pickup proof.\nExample: {"item":"raw_iron","quantity":3} adds at least three raw iron, not three ore blocks.');
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
    new GetChestContentsCapability(),
    "Does: Read items and quantities in the single accessible ordinary chest, then close it.\nSuccess: Server contents were observed; no items transferred.\nLimits: No movement. Requires one unambiguous reachable chest; no double chests or other storage types.\nNotes: Returns chest contents, not bot inventory. Example: {}.",
  );
  register(
    registry,
    new UseChestCapability(),
    'Does: Deposit or withdraw items from the single accessible ordinary chest, then close it.\nSuccess: Exact opposite server-confirmed changes in chest and bot inventory.\nLimits: No movement; ordinary items in a single chest only. quantity is an exact transfer, not final stock.\nNotes: On partial or unconfirmed transfer, read chest and bot inventory before retrying. Example: {"direction":"deposit","item":"oak_log","quantity":2}.',
  );
  register(
    registry,
    new GetFurnaceContentsCapability(),
    "Does: Read the accessible furnace's input, fuel, output and cooking state, then close it.\nSuccess: Server contents observed without moving items.\nLimits: No movement or collection. Cooking may continue; empty fuel slot does not mean extinguished.\nNotes: Approach the intended furnace first. Example: {}.",
  );
  register(registry, new UseFurnaceCapability(),
    'Does: Smelt raw_iron using coal in the single accessible empty furnace; collect iron_ingot and close it.\nSuccess: Requested ingots confirmed in bot inventory.\nLimits: No movement or gathering; supports 1-16 raw_iron with coal only. Requires empty furnace slots and space for output. Up to 210 seconds.\nNotes: Stop/failure may leave items cooking. Read the furnace and bot inventory before retrying; no automatic recovery of earlier output. Example: {"inputItem":"raw_iron","quantity":3,"fuel":"coal"}.');
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
