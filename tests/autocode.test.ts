import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  initDatabase,
  getChannelBinding,
  saveChannelBinding,
  effectiveAutocode,
  saveProjectState,
} from "../src/storage/index.js";
import { useFakeHome } from "./helpers.js";
import type { ChannelBinding } from "../src/types/index.js";

function bind(channelId: string, projectAlias: string, autocode: "inherit" | "enabled" | "disabled") {
  const existing = getChannelBinding(channelId);
  const b: ChannelBinding = {
    channelId,
    projectAlias,
    autocode,
    autocodeEnabled: autocode === "enabled",
    activeSessionId: existing?.activeSessionId,
    threadSessionMap: new Map(),
  };
  saveChannelBinding(b);
}

describe("effectiveAutocode inheritance", () => {
  beforeAll(() => {
    useFakeHome();
    initDatabase();
    saveProjectState({ alias: "proj", path: "C:/some/project", autocodeEnabled: false });
  });
  beforeEach(() => {
    // Fresh channels each test.
    bind("parent-1", "proj", "inherit");
    bind("parent-2", "proj", "enabled");
    bind("parent-3", "proj", "disabled");
  });

  it("defaults to off when there is no binding at all", () => {
    expect(effectiveAutocode("ghost-thread", null)).toBe(false);
  });

  it("inherit falls back to the parent channel setting", () => {
    bind("thread-inherit", "proj", "inherit");
    expect(effectiveAutocode("thread-inherit", "parent-2")).toBe(true);
    expect(effectiveAutocode("thread-inherit", "parent-3")).toBe(false);
  });

  it("a thread explicitly enabled stays on even if the parent disables it", () => {
    bind("thread-on", "proj", "enabled");
    expect(effectiveAutocode("thread-on", "parent-3")).toBe(true);
  });

  it("a thread explicitly disabled stays off even if the parent enables it", () => {
    bind("thread-off", "proj", "disabled");
    expect(effectiveAutocode("thread-off", "parent-2")).toBe(false);
  });

  it("an explicitly enabled thread with no parent binding is on", () => {
    bind("sole-thread", "proj", "enabled");
    expect(effectiveAutocode("sole-thread", null)).toBe(true);
  });
});
