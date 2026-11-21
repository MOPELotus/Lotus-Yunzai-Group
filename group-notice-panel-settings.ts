import { createNoticeSettingsStore, NoticeSettingsConflictError, NoticeSettingsPermissionError, type NoticeSettingsField } from "./notice-settings-store.ts";

const panelFields = [
  "groupMessage", "grouptemporaryMessage", "groupRecall", "addGroupApplication",
  "groupNumberChange", "groupMemberNumberChange", "groupAdminChange", "botBeenBanned",
] as const satisfies readonly NoticeSettingsField[];

export type GroupNoticePanelField = typeof panelFields[number];
export type GroupNoticePanelSettings = Record<GroupNoticePanelField, boolean>;
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
  constructor() { super("通知设置修改仅接受支持的群通知布尔字段和有效版本。"); }
}
export class GroupNoticePanelSettingsUnavailable extends Error {
  readonly code = "GROUP_NOTICE_SETTINGS_UNAVAILABLE";
  constructor() { super("暂无法安全保存通知设置。"); }
}

function parsePatch(patch: unknown): (readonly [GroupNoticePanelField, boolean])[] {
  if (!patch || typeof patch !== "object" || ![null, Object.prototype].includes(Object.getPrototypeOf(patch))) {
    throw new GroupNoticePanelSettingsInputError();
  }
  return Reflect.ownKeys(patch).map(key => {
    const entry = Object.getOwnPropertyDescriptor(patch, key);
    if (typeof key !== "string" || !panelFields.includes(key as GroupNoticePanelField) ||
        !entry || !("value" in entry) || typeof entry.value !== "boolean") throw new GroupNoticePanelSettingsInputError();
    return [key as GroupNoticePanelField, entry.value as boolean] as const;
  });
}

export function createGroupNoticePanelSettings(root: URL, lockFile: Parameters<typeof createNoticeSettingsStore>[1]) {
  const store = createNoticeSettingsStore(root, lockFile);
  function project(snapshot: Awaited<ReturnType<typeof store.readVersionedDefaults>>): GroupNoticePanelSettingsSnapshot {
    const { values, revision, writable } = snapshot;
    const settings = Object.fromEntries(panelFields.map(key => [key, values.get(key) === true])) as GroupNoticePanelSettings;
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
