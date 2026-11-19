import { changeGroupCard } from "./group-card.ts";

export class GroupCard extends plugin {
  constructor() {
    super({
      name: "椰奶小助手",
      event: "message",
      priority: 1000,
      rule: [{ reg: "^#改群名片", fnc: "changeGroupCard" }],
    });
  }

  async changeGroupCard() {
    await this.reply(await changeGroupCard(this.e));
    return true;
  }
}
