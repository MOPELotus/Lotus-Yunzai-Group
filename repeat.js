class Repeat extends plugin {
  constructor() {
    super({
      name: "主动复读",
      event: "message",
      priority: 5000,
      rule: [{ reg: /^#复读$/u, fnc: "repeat", permission: "master" }],
    });
  }

  async repeat() {
    if (!this.setContext("repeatMessage")) {
      return this.reply("无法建立复读会话。");
    }
    try {
      const sent = await this.reply("请发送要复读的内容", false, { at: true });
      if (sent === false) this.finish("repeatMessage");
      return sent;
    } catch (error) {
      this.finish("repeatMessage");
      throw error;
    }
  }

  repeatMessage() {
    this.finish("repeatMessage");
    if (!this.e.isMaster) return false;
    return this.reply(this.e.message, false, { recallMsg: 5 });
  }
}

export const apps = { Repeat };
