import { createNoticeSettingsStore, NoticeSettingsConflictError, NoticeSettingsPermissionError, type NoticeSettingsField } from "./notice-settings-store.ts";
import { recallRetentionSeconds } from "./recall-notice.ts";

const booleanFields = [
  "privateMessage", "groupMessage", "grouptemporaryMessage", "PrivateRecall", "groupRecall",
  "friendRequest", "groupInviteRequest", "addGroupApplication", "friendNumberChange",
  "groupNumberChange", "groupMemberNumberChange", "groupAdminChange", "botBeenBanned", "notificationsAll",
] as const satisfies readonly NoticeSettingsField[];
const panelFields = [...booleanFields, "msgSaveDeltime"] as const satisfies readonly NoticeSettingsField[];

export type GroupNoticePanelField = typeof panelFields[number];
export type GroupNoticePanelSettings = Record<typeof booleanFields[number], boolean> & { msgSaveDeltime: number | null };
export interface GroupNoticePanelSettingsSnapshot {
  readonly settings: GroupNoticePanelSettings;
  readonly revision: string;
  readonly writable: boolean;
}

export { NoticeSettingsPermissionError as GroupNoticePanelSettingsPermission };

export class GroupNoticePanelSettingsConflict extends Error {
  readonly code = "GROUP_NOTICE_SETTINGS_CONFLICT";
  constructor() { super("通知设置已变更，请重新读取后保存。"); }
}
export class GroupNoticePanelSettingsInputError extends Error {
  readonly code = "GROUP_NOTICE_SETTINGS_INPUT";
  constructor() { super("请选择有效的通知开关、撤回缓存秒数及配置版本。"); }
}
export class GroupNoticePanelSettingsUnavailable extends Error {
  readonly code = "GROUP_NOTICE_SETTINGS_UNAVAILABLE";
  constructor() { super("暂无法安全保存通知设置。"); }
}

function parsePatch(patch: unknown): (readonly [GroupNoticePanelField, boolean | number])[] {
  if (!patch || typeof patch !== "object" || ![null, Object.prototype].includes(Object.getPrototypeOf(patch))) {
    throw new GroupNoticePanelSettingsInputError();
  }
  return Reflect.ownKeys(patch).map(key => {
    const entry = Object.getOwnPropertyDescriptor(patch, key);
    if (typeof key !== "string" || !panelFields.includes(key as GroupNoticePanelField) ||
        !entry || !("value" in entry)) throw new GroupNoticePanelSettingsInputError();
    const value: unknown = entry.value;
    if (key === "msgSaveDeltime") {
      if (typeof value !== "number" || recallRetentionSeconds(value) === undefined) throw new GroupNoticePanelSettingsInputError();
      return [key, value] as const;
    }
    if (typeof value !== "boolean") throw new GroupNoticePanelSettingsInputError();
    return [key as typeof booleanFields[number], value] as const;
  });
}

export function createGroupNoticePanelSettings(root: URL, lockFile: Parameters<typeof createNoticeSettingsStore>[1]) {
  const store = createNoticeSettingsStore(root, lockFile);
  function project(snapshot: Awaited<ReturnType<typeof store.readVersionedDefaults>>): GroupNoticePanelSettingsSnapshot {
    const { values, revision, writable } = snapshot;
    const switches = Object.fromEntries(booleanFields.map(key => [key,
      key === "notificationsAll" ? values.get(key) !== false : values.get(key) === true,
    ])) as Record<typeof booleanFields[number], boolean>;
    const settings = { ...switches, msgSaveDeltime: recallRetentionSeconds(values.get("msgSaveDeltime")) ?? null };
    return { settings, revision, writable };
  }
  return {
    async read(): Promise<GroupNoticePanelSettingsSnapshot> {
      return project(await store.readVersionedDefaults(panelFields));
    },
    async write(revision: string, patch: unknown, canWrite: () => boolean = () => true): Promise<GroupNoticePanelSettingsSnapshot> {
      if (typeof revision !== "string" || !/^[a-f0-9]{64}$/u.test(revision) || revision.length !== 64) {
        throw new GroupNoticePanelSettingsInputError();
      }
      const updates = parsePatch(patch);
      try { return project(await store.writeVersionedDefaults(revision, panelFields, updates, canWrite)); }
      catch (error) {
        if (error instanceof NoticeSettingsPermissionError) throw error;
        if (error instanceof NoticeSettingsConflictError) throw new GroupNoticePanelSettingsConflict();
        throw new GroupNoticePanelSettingsUnavailable();
      }
    },
  };
}
