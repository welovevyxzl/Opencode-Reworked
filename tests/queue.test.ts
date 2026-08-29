import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "../src/storage/index.js";
import * as qs from "../src/opencode/queue-service.js";
import { useFakeHome } from "./helpers.js";

function enq(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const item = qs.enqueue({ prompt: `task ${i}`, channelId: "c", threadId: "t", projectAlias: "proj" });
    ids.push(item.id);
  }
  return ids;
}

describe("queue-service", () => {
  beforeAll(() => {
    useFakeHome();
    initDatabase();
    qs.initQueueService();
  });
  beforeEach(() => {
    qs.setPaused(false);
    // Isolate each test: wipe every queue row so a job left active (starting/
    // running/cancelling) by a previous test cannot block the single-slot claim.
    const db = getDatabase();
    if (db) db.prepare("DELETE FROM queue_items").run();
  });

  it("enqueues and claims jobs in FIFO order", () => {
    const ids = enq(3);
    const c1 = qs.claimNextJob()!;
    expect(c1.id).toBe(ids[0]);
    expect(c1.status).toBe("starting");
    // The execution slot is occupied; no further claims return a job.
    expect(qs.claimNextJob()).toBeNull();
    expect(qs.getQueuePosition(ids[1])).toBe(1);
  });

  it("advances starting -> running -> completed", () => {
    const [id] = enq(1);
    const c = qs.claimNextJob()!;
    expect(qs.markRunning(c.id)).toBe(true);
    expect(qs.getJob(id)!.status).toBe("running");
    expect(qs.markCompleted(c.id, "done")).toBe(true);
    const job = qs.getJob(id)!;
    expect(job.status).toBe("completed");
    expect(job.result).toBe("done");
  });

  it("rejects a second claim while a job is active (single slot)", () => {
    enq(2);
    qs.claimNextJob();
    expect(qs.claimNextJob()).toBeNull();
  });

  it("fails a job with an error and pauses when continueOnFailure is disabled", () => {
    const [id] = enq(1);
    const c = qs.claimNextJob()!;
    expect(qs.markFailed(c.id, "boom")).toBe(true);
    expect(qs.getJob(id)!.error).toBe("boom");
    const outcome = qs.onJobFailure(false);
    expect(outcome.paused).toBe(true);
    expect(qs.isPaused()).toBe(true);
  });

  it("does not pause when continueOnFailure is enabled", () => {
    enq(1);
    qs.claimNextJob();
    const outcome = qs.onJobFailure(true);
    expect(outcome.paused).toBe(false);
    expect(qs.isPaused()).toBe(false);
  });

  it("pauses and resumes the queue", () => {
    qs.setPaused(true);
    enq(1);
    expect(qs.claimNextJob()).toBeNull();
    qs.setPaused(false);
    expect(qs.claimNextJob()).not.toBeNull();
  });

  it("clearQueued cancels everything that has not started but leaves the active job", () => {
    enq(3);
    const active = qs.claimNextJob()!;
    const cleared = qs.clearQueued();
    expect(cleared).toBe(2);
    expect(qs.getJob(active.id)!.status).not.toBe("cancelled");
    expect(qs.getQueuedJobs()).toHaveLength(0);
  });

  it("removeQueuedJob removes a job before it starts", () => {
    const [id] = enq(2);
    const c = qs.claimNextJob()!;
    const other = qs.getQueuedJobs()[0];
    const r = qs.removeQueuedJob(other.id);
    expect(r.ok).toBe(true);
    expect(qs.getJob(other.id)).toBeNull();
    // Cannot remove a job that is already active.
    expect(qs.removeQueuedJob(c.id).ok).toBe(false);
    void id;
  });

  it("is idempotent for cancelled jobs (duplicate cancel succeeds silently)", () => {
    const [id] = enq(1);
    const c = qs.claimNextJob()!;
    qs.markRunning(c.id);
    qs.markCancelled(c.id, "stop it");
    expect(qs.markCancelled(c.id, "again")).toBe(true);
    expect(qs.getJob(id)!.status).toBe("cancelled");
  });

  it("requeueJob is bounded by max attempts", () => {
    const [id] = enq(1);
    const c = qs.claimNextJob()!;
    qs.markRunning(c.id);
    qs.markFailed(c.id, "err");
    let requeued = 0;
    for (let i = 0; i < 5; i++) {
      if (qs.requeueJob(c.id, "retry")) requeued++;
    }
    expect(requeued).toBeLessThanOrEqual(3);
    void id;
  });

  it("recoverInterruptedJobs requeues running jobs and treats cancelling as cancelled", async () => {
    // A running job whose session is still alive is requeued on restart.
    const [first] = enq(1);
    const a = qs.claimNextJob()!;
    qs.markRunning(a.id);
    const report = await qs.recoverInterruptedJobs({ sessionAlive: async () => true });
    expect(report.inspected).toBe(1);
    expect(report.requeued).toContain(first);
    expect(qs.getJob(first)!.status).toBe("queued");

    // Clear the requeued job so the single execution slot is free again.
    qs.removeQueuedJob(first);

    // A job whose cancellation was in flight is treated as cancelled on restart.
    const [second] = enq(1);
    const b = qs.claimNextJob()!;
    qs.markRunning(b.id);
    qs.markCancelling(b.id, "crash before cancel finished");
    const report2 = await qs.recoverInterruptedJobs({ sessionAlive: async () => true });
    expect(report2.inspected).toBe(1);
    expect(report2.cancelled).toContain(second);
    expect(qs.getJob(second)!.status).toBe("cancelled");
  });

  it("persists queue state across a database reopen", () => {
    const [id] = enq(1);
    const c = qs.claimNextJob()!;
    qs.markRunning(c.id);
    closeDatabase();
    initDatabase();
    qs.initQueueService();
    expect(qs.getJob(id)!.status).toBe("running");
  });
});
