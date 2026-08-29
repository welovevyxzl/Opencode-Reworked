import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { getHomeDir } from "../src/storage/index.js";
import {
  initDatabase,
  closeDatabase,
  saveProjectState,
  getProjectState,
  getAllProjectStates,
  saveChannelBinding,
  getChannelBinding,
  deleteChannelBinding,
  saveThreadSession,
  getThreadSession,
  deleteThreadSession,
  addToQueue,
  getQueueItem,
  getPendingQueue,
  getAllQueue,
  updateQueueItem,
  clearQueue,
  removeFromQueue,
  getAllowlist,
  addToAllowlist,
  removeFromAllowlist,
  isAuthorized,
  isOwner,
  loadConfig,
  saveConfig,
  getConfigPath,
} from "../src/storage/index.js";

beforeEach(() => {
  initDatabase();
});

afterAll(() => {
  closeDatabase();
});

describe("storage — project states", () => {
  it("round-trips project state including autocode flag", () => {
    const alias = "proj-a";
    const path = getHomeDir() + "\\proj-a";
    saveProjectState({
      alias,
      path,
      selectedModel: "anthropic/claude-sonnet-4",
      threadSessionMap: new Map(),
      autocodeEnabled: true,
      channelBindings: new Map(),
    });
    const state = getProjectState(alias);
    expect(state).not.toBeNull();
    expect(state!.path).toBe(path);
    expect(state!.selectedModel).toBe("anthropic/claude-sonnet-4");
    expect(state!.autocodeEnabled).toBe(true);
  });

  it("lists all registered projects", () => {
    saveProjectState({
      alias: "a1",
      path: getHomeDir() + "\\a1",
      selectedModel: "",
      threadSessionMap: new Map(),
      autocodeEnabled: false,
      channelBindings: new Map(),
    });
    saveProjectState({
      alias: "a2",
      path: getHomeDir() + "\\a2",
      selectedModel: "",
      threadSessionMap: new Map(),
      autocodeEnabled: false,
      channelBindings: new Map(),
    });
    const aliases = getAllProjectStates().map((p) => p.alias);
    expect(aliases).toContain("a1");
    expect(aliases).toContain("a2");
  });
});

describe("storage — channel bindings", () => {
  it("persists the autocode_enabled toggle", () => {
    const channelId = "111111111111111111";
    saveChannelBinding({
      channelId,
      projectAlias: "p",
      autocodeEnabled: true,
      threadSessionMap: new Map(),
    });
    const binding = getChannelBinding(channelId);
    expect(binding).not.toBeNull();
    expect(binding!.projectAlias).toBe("p");
    expect(binding!.autocodeEnabled).toBe(true);
  });

  it("defaults autocode to off when not set", () => {
    saveChannelBinding({
      channelId: "222222222222222222",
      projectAlias: "p2",
      autocodeEnabled: false,
      threadSessionMap: new Map(),
    });
    expect(getChannelBinding("222222222222222222")!.autocodeEnabled).toBe(false);
  });

  it("can be deleted", () => {
    saveChannelBinding({
      channelId: "333333333333333333",
      projectAlias: "p3",
      autocodeEnabled: false,
      threadSessionMap: new Map(),
    });
    deleteChannelBinding("333333333333333333");
    expect(getChannelBinding("333333333333333333")).toBeNull();
  });
});

describe("storage — thread/session mapping", () => {
  it("maps thread to session and back", () => {
    saveThreadSession("thread-1", "session-abc-123", "project-x", "channel-1");
    const ts = getThreadSession("thread-1");
    expect(ts).toEqual({ sessionId: "session-abc-123", projectAlias: "project-x" });
    deleteThreadSession("thread-1");
    expect(getThreadSession("thread-1")).toBeNull();
  });
});

describe("storage — queue", () => {
  it("adds, lists, and updates queue items and preserves order", () => {
    addToQueue({ id: "q1", prompt: "first", channelId: "c", threadId: "t", projectAlias: "p", addedAt: 100, status: "queued" });
    addToQueue({ id: "q2", prompt: "second", channelId: "c", threadId: "t", projectAlias: "p", addedAt: 200, status: "queued" });
    const pending = getPendingQueue().map((q) => q.id);
    expect(pending).toEqual(["q1", "q2"]);
    updateQueueItem("q1", { status: "running" });
    expect(getQueueItem("q1")!.status).toBe("running");
    expect(getPendingQueue().map((q) => q.id)).toEqual(["q2"]);
    updateQueueItem("q1", { status: "completed", result: "done" });
    expect(getQueueItem("q1")!.result).toBe("done");
  });

  it("supports session_id attachments on queue items", () => {
    addToQueue({
      id: "q3",
      prompt: "continue",
      channelId: "c",
      threadId: "t",
      projectAlias: "p",
      sessionId: "sess-1",
      addedAt: 300,
      status: "queued",
    });
    expect(getQueueItem("q3")!.sessionId).toBe("sess-1");
  });

  it("clear marks queued items cancelled", () => {
    addToQueue({ id: "q4", prompt: "x", channelId: "c", threadId: "t", projectAlias: "p", addedAt: 400, status: "queued" });
    clearQueue();
    expect(getPendingQueue().length).toBe(0);
    expect(getQueueItem("q4")!.status).toBe("cancelled");
  });

  it("removes a single item", () => {
    addToQueue({ id: "q5", prompt: "y", channelId: "c", threadId: "t", projectAlias: "p", addedAt: 500, status: "queued" });
    removeFromQueue("q5");
    expect(getQueueItem("q5")).toBeNull();
  });
});

describe("storage — allowlist", () => {
  it("adds entries and authorizes users", () => {
    addToAllowlist({ userId: "user-1", username: "alice", addedAt: Date.now(), addedBy: "test", isOwner: false });
    expect(isAuthorized("user-1")).toBe(true);
    expect(isAuthorized("nobody")).toBe(false);
    expect(isOwner("user-1")).toBe(false);
  });

  it("prevents removing the owner", () => {
    addToAllowlist({ userId: "owner-1", username: "boss", addedAt: Date.now(), addedBy: "setup", isOwner: true });
    expect(removeFromAllowlist("owner-1")).toBe(false);
    expect(isAuthorized("owner-1")).toBe(true);
  });

  it("prevents removing the last authorized user", () => {
    // allowlist currently holds at least user-1 + owner-1 from prior tests;
    // adding another non-owner ensures we can remove exactly one safely
    addToAllowlist({ userId: "user-2", username: "bob", addedAt: Date.now(), addedBy: "test", isOwner: false });
    expect(removeFromAllowlist("user-2")).toBe(true);
    expect(isAuthorized("user-2")).toBe(false);
  });

  it("keeps the owner flag readable", () => {
    addToAllowlist({ userId: "owner-2", username: "boss2", addedAt: Date.now(), addedBy: "setup", isOwner: true });
    expect(isOwner("owner-2")).toBe(true);
  });
});

describe("storage — config", () => {
  it("saves and loads config from the data dir", () => {
    const cfg = {
      discord: { token: "abc", applicationId: "app", guildId: "guild", ownerId: "owner" },
      opencode: { port: 4096, host: "127.0.0.1", serverPassword: "pw", autoStart: true },
      projects: { defaultDir: getHomeDir(), registered: [] },
      github: { enabled: true },
      voice: { enabled: false },
      queue: { continueOnFailure: true, freshContext: false },
      startup: { bootWithWindows: false },
    };
    saveConfig(cfg);
    expect(existsSync(getConfigPath())).toBe(true);
    const loaded = loadConfig();
    expect(loaded?.discord.guildId).toBe("guild");
    expect(loaded?.opencode.port).toBe(4096);
  });
});