import { randomBytes } from "crypto";
import type { Config } from "../types/index.js";
import { isAuthorized, addToAllowlist, loadConfig } from "../storage/index.js";

export function generateServerPassword(): string {
  return randomBytes(24).toString("base64url");
}

export function sanitizeToken(token: string): string {
  return token.slice(0, 6) + "···" + token.slice(-4);
}

export function validateDiscordTokenFormat(token: string): boolean {
  return /^[A-Za-z0-9._-]{20,}$/.test(token.trim());
}

export function containsSecret(input: string): boolean {
  const secretPatterns = [
    /discord[-_]?token/i,
    /api[-_]?key/i,
    /openai[-_]?key/i,
    /gho_|ghp_|ghu_|ghs_|ghr_/i,
  ];
  return secretPatterns.some((p) => p.test(input));
}

export function ensureOwnerInAllowlist(): boolean {
  const config = getConfig();
  if (!config) return false;
  const ownerId = config.discord.ownerId;
  if (!ownerId) return false;

  if (!isAuthorized(ownerId)) {
    addToAllowlist({
      userId: ownerId,
      username: "owner",
      addedAt: Date.now(),
      addedBy: "setup",
      isOwner: true,
    });
    return true;
  }
  return false;
}

export interface AuthResult {
  ok: boolean;
  owner: boolean;
  authorized: boolean;
}

export function checkAuth(userId: string): AuthResult {
  const authorized = isAuthorized(userId);
  if (!authorized) {
    return { ok: false, owner: false, authorized: false };
  }
  const owner = userId === getOwnerId();
  return { ok: true, owner, authorized: true };
}

export function getOwnerId(): string {
  const config = getConfig();
  return config?.discord.ownerId ?? "";
}

export function getConfig(): Config | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}