import { GroupDeparture, GroupNewcomer } from "./member-notices-v3.js";
import { apps as repeat } from "./repeat.js";

export { default, createGroupPlugin } from "./likes.ts";
export const apps = { ...repeat, GroupNewcomer, GroupDeparture };
