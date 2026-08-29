import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { logInfo, logWarn } from "../utils/logger.js";

/**
 * Project-level prompt context: `.ocr/instructions.md` (persistent guidance,
 * e.g. frontend quality bar) and `.ocr/memory.md` (curated durable memory).
 * Both are optional; when present they are appended to coding prompts.
 */

const MAX_INSTRUCTIONS_BYTES = 12 * 1024;
const MAX_MEMORY_BYTES = 8 * 1024;

export interface ProjectContext {
  instructions?: string;
  memory?: string;
}

function readBounded(path: string, maxBytes: number): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, "utf-8").trim();
    if (!content) return undefined;
    if (content.length > maxBytes) return content.slice(0, maxBytes) + "\n…(truncated)";
    return content;
  } catch (err) {
    logWarn(`Could not read ${path}: ${String(err)}`, "project-context");
    return undefined;
  }
}

export function loadProjectContext(projectDir: string | undefined): ProjectContext {
  if (!projectDir) return {};
  const dir = join(projectDir, ".ocr");
  return {
    instructions: readBounded(join(dir, "instructions.md"), MAX_INSTRUCTIONS_BYTES),
    memory: readBounded(join(dir, "memory.md"), MAX_MEMORY_BYTES),
  };
}

/** Build the appended context block for a prompt. Empty string when none configured. */
export function buildPromptContext(projectDir: string | undefined): string {
  const ctx = loadProjectContext(projectDir);
  const blocks: string[] = [];
  if (ctx.instructions) {
    blocks.push(`--- PROJECT INSTRUCTIONS (.ocr/instructions.md) — follow these for all work in this project ---\n${ctx.instructions}`);
  }
  if (ctx.memory) {
    blocks.push(`--- PROJECT MEMORY (.ocr/memory.md) — durable decisions and constraints ---\n${ctx.memory}`);
  }
  return blocks.length > 0 ? "\n\n" + blocks.join("\n\n") : "";
}

export function getMemoryPath(projectDir: string): string {
  return join(projectDir, ".ocr", "memory.md");
}

export function getInstructionsPath(projectDir: string): string {
  return join(projectDir, ".ocr", "instructions.md");
}

export function addMemoryEntry(projectDir: string, entry: string, author: string): { ok: boolean; error?: string } {
  try {
    const dir = join(projectDir, ".ocr");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = getMemoryPath(projectDir);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const line = `- ${entry.trim()} _(added by ${author}, ${stamp})_\n`;
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf-8");
      if (existing.length + line.length > MAX_MEMORY_BYTES * 4) {
        return { ok: false, error: "Memory file is near its size cap. Curate it with /memory clear or edit the file directly." };
      }
      appendFileSync(path, line, "utf-8");
    } else {
      writeFileSync(path, `# Project memory\n\n${line}`, "utf-8");
    }
    logInfo("Project memory updated", "project-context", { projectDir });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function clearMemory(projectDir: string): { ok: boolean; error?: string } {
  try {
    const path = getMemoryPath(projectDir);
    if (existsSync(path)) writeFileSync(path, "# Project memory\n", "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
