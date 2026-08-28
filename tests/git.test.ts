import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  gitCommand,
  isGitRepo,
  initRepo,
  stageAll,
  commit,
  getStatus,
  getCurrentBranch,
  getDiff,
  diffToFile,
  initGitIgnore,
  containsGitRepo,
  log,
  listBranches,
  createBranch,
} from "../src/git/index.js";

const gitOk = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
let repo: string;

beforeAll(async () => {
  if (!gitOk) return;
  repo = mkdtempSync(join(tmpdir(), "ocr-git-test-"));
  const init = await initRepo(repo);
  if (!init.ok) throw new Error("git init failed");
  await gitCommand(repo, ["config", "user.email", "test@example.com"], 3000);
  await gitCommand(repo, ["config", "user.name", "Test"], 3000);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe.skipIf(!gitOk)("git module", () => {
  it("detects a fresh repository", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    expect(containsGitRepo(repo)).toBe(true);
  });

  it("reports the current branch", async () => {
    const branch = await getCurrentBranch(repo);
    expect(["main", "master"]).toContain(branch);
  });

  it("commits staged files with a spaced message and keeps state clean", async () => {
    writeFileSync(join(repo, "hello.txt"), "hi there\n");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    const stage = await stageAll(repo);
    expect(stage.ok).toBe(true);
    const res = await commit(repo, "Add hello world and ignore rules");
    expect(res.ok).toBe(true);
    const status = await getStatus(repo);
    expect(status).not.toBeNull();
    expect(status!.clean).toBe(true);
  });

  it("detects modified files after a change", async () => {
    writeFileSync(join(repo, "hello.txt"), "changed content\n");
    const status = await getStatus(repo);
    expect(status!.clean).toBe(false);
  });

  it("produces a git diff", async () => {
    const diff = await getDiff(repo);
    expect(diff.ok).toBe(true);
    expect(diff.output).toContain("changed content");
  });

  it("writes a diff file into the managed state dir", async () => {
    const diff = await getDiff(repo);
    const file = await diffToFile(repo, diff.output);
    expect(existsSync(file)).toBe(true);
  });

  it("lists branches and creates new ones with spaces-safe names", async () => {
    const before = await listBranches(repo);
    expect(before.length).toBeGreaterThanOrEqual(1);
    const created = await createBranch(repo, "feature/test");
    expect(created.ok).toBe(true);
    const after = await listBranches(repo);
    expect(after).toContain("feature/test");
  });

  it("records commit history with messages", async () => {
    const commits = await log(repo, 5);
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].message).toBe("Add hello world and ignore rules");
    expect(commits[0].author).toBe("Test");
  });

  it("adds a .gitignore only if missing", async () => {
    writeFileSync(join(repo, "temp-ignored.log"), "x");
    await initGitIgnore(repo);
    expect(existsSync(join(repo, ".gitignore"))).toBe(true);
  });
});