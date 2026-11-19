import { announceDeparture, welcomeMember } from "./member-notices.ts";

export class GroupNewcomer extends plugin {
  constructor() {
    super({ name: "欢迎新人", event: "notice.group.increase" });
  }

  async accept() {
    await welcomeMember(this.e);
  }
}

export class GroupDeparture extends plugin {
  constructor() {
    super({ name: "退群通知", event: "notice.group.decrease" });
  }

  async accept() {
    await announceDeparture(this.e);
  }
}
