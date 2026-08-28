import { describe, it, expect } from "vitest";
import {
  parseConfirmationId,
  CONFIRM_TIMEOUT_MS,
} from "../src/commands/confirmations.js";

describe("device-action confirmations", () => {
  it("parses valid confirmation ids for all actions and choices", () => {
    for (const action of ["sleep", "restart", "shutdown"]) {
      for (const choice of ["yes", "no"]) {
        const id = `confirm_${action}_${choice}_abc123xy`;
        const parsed = parseConfirmationId(id);
        expect(parsed).toEqual({ action, choice, key: "abc123xy" });
      }
    }
  });

  it("rejects malformed ids", () => {
    expect(parseConfirmationId("confirm_reboot_yes_key1")).toBeNull();
    expect(parseConfirmationId("oc_stop")).toBeNull();
    expect(parseConfirmationId("confirm_sleep_maybe_key1")).toBeNull();
    expect(parseConfirmationId("")).toBeNull();
  });

  it("exposes a 30 second confirmation window", () => {
    expect(CONFIRM_TIMEOUT_MS).toBe(30000);
  });
});