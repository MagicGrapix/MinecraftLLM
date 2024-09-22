import { BotAction, BotManager } from "./BotManager";



// Example concrete class extending BotAction
export class MyBotAction extends BotAction {
  async execute(): Promise<void> {
    console.log('Executing MyBotAction');
    this.manager.bot.chat("COUCOU c'est moi");
    // Custom logic here
  }

  // Override specific methods
  chat(username: string, message: string): void {
    console.log(`Chat event: ${username} said ${message}`);
    this.complete();
  }

  // Override other methods as needed
  error(err: Error): void {
    console.error(`Custom error handling: ${err.message}`);
  }
}


// Define the `GiveItemsAction` class that will extend from `BotAction`.
export class GiveItemsAction extends BotAction {
  private items: { name: string, count: number }[];

  constructor(manager: BotManager, items: { name: string, count: number }[]) {
    super(manager);
    this.items = items;
  }

  // The main logic to give items to the bot.
  public execute(): void {
    if (!this.items || this.items.length === 0) {
      this.failed("No items specified for giving.");
      return;
    }

    // For each item in the list, use the `/give` command to give it to the bot.
    this.items.forEach(item => {
      this.manager.bot.chat(`/give ${this.manager.bot.username} ${item.name} ${item.count}`);
    });

    // After issuing all the give commands, we complete the action.
    this.complete();
  }
}