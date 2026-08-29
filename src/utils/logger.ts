import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { LogEntry } from "../types/index.js";

const REDACT_PATTERNS = [
  /discord[-_]?token[:\s]*["']?([A-Za-z0-9._-]{20,})["']?/gi,
  /(?:api[-_]?key|openai[-_]?key|OPENAI_API_KEY)[:\s]*["']?([A-Za-z0-9._-]{20,})["']?/gi,
  /(?:gho|ghp|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/gi,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /(?:password|serverPassword|SERVER_PASSWORD|OPENCODE_SERVER_PASSWORD)[:\s=]*["']?([^\s"']{8,})["']?/gi,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

function redact(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const redacted = match.slice(0, 8) + "***REDACTED***";
      return redacted;
    });
  }
  return result;
}

const MAX_LOG_SIZE = 10 * 1024 * 1024;
const MAX_LOG_FILES = 5;

let logDir = "";
let currentLogLevel: LogEntry["level"] = "INFO";
let logFilePath = "";
let logFileIndex = 0;

const LEVELS: Record<LogEntry["level"], number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

export function initLogger(level: LogEntry["level"] = "INFO"): void {
  logDir = join(homedir(), ".opencode-remote", "logs");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  currentLogLevel = level;
  logFilePath = join(logDir, `bot-${logFileIndex}.log`);
  rotateIfNeeded();
}

function rotateIfNeeded(): void {
  try {
    if (existsSync(logFilePath)) {
      const stat = statSync(logFilePath);
      if (stat.size > MAX_LOG_SIZE) {
        logFileIndex++;
        if (logFileIndex >= MAX_LOG_FILES) {
          logFileIndex = 0;
        }
        logFilePath = join(logDir, `bot-${logFileIndex}.log`);
        writeFileSync(logFilePath, "");
      }
    }
  } catch {
    // ignore rotation errors
  }
}

function writeLog(entry: LogEntry): void {
  if (LEVELS[entry.level] < LEVELS[currentLogLevel]) return;

  const timestamp = new Date(entry.timestamp).toISOString();
  const context = entry.context ? `[${entry.context}]` : "";
  const job = entry.jobId ? `[job=${entry.jobId}]` : "";
  const event = entry.event ? `[${entry.event}]` : "";
  const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
  const line = redact(`${timestamp} ${entry.level.padEnd(5)} ${context}${job}${event} ${entry.message}${dataStr}\n`);

  const consoleMethod =
    entry.level === "ERROR"
      ? "error"
      : entry.level === "WARN"
        ? "warn"
        : "log";
  console[consoleMethod](line.trimEnd());

  if (logFilePath) {
    try {
      rotateIfNeeded();
      appendFileSync(logFilePath, line);
    } catch {
      // can't log about logging failure
    }
  }
}

export function logDebug(message: string, context?: string, data?: unknown): void {
  writeLog({ timestamp: Date.now(), level: "DEBUG", message, context, data });
}

export function logInfo(message: string, context?: string, data?: unknown): void {
  writeLog({ timestamp: Date.now(), level: "INFO", message, context, data });
}

export function logWarn(message: string, context?: string, data?: unknown): void {
  writeLog({ timestamp: Date.now(), level: "WARN", message, context, data });
}

export function logError(message: string, context?: string, data?: unknown): void {
  writeLog({ timestamp: Date.now(), level: "ERROR", message, context, data });
}

/**
 * Structured job lifecycle logging: QUEUED, CLAIMED, SESSION_RESOLVED,
 * PROMPT_SENT, TOOL_EVENT, COMPLETED, FAILED, CANCELLING, CANCELLED, RECOVERED...
 */
export function logJobEvent(
  level: LogEntry["level"],
  event: string,
  jobId: string,
  message: string,
  data?: unknown
): void {
  writeLog({ timestamp: Date.now(), level, message, context: "job", jobId, event, data });
}

const LINE_RE = /^(\S+)\s+(DEBUG|INFO|WARN|ERROR)\s+(?:\[(?:[^\]]*)\])?(?:\[job=([^\]]+)\])?(?:\[([A-Z_]+)\])?\s?(.*)$/;

export function getRecentLogs(
  lines: number = 50,
  level?: LogEntry["level"],
  jobId?: string
): LogEntry[] {
  if (!logFilePath || !existsSync(logFilePath)) return [];
  try {
    const content = readFileSync(logFilePath, "utf-8");
    let allLines = content.split("\n").filter((l) => l.trim());
    if (jobId) {
      allLines = allLines.filter((l) => l.includes(`[job=${jobId}]`) || l.includes(jobId));
    }
    const recent = allLines.slice(-lines);
    const parsed = recent.map((line): LogEntry | null => {
      const match = line.match(LINE_RE);
      if (!match) return null;
      return {
        timestamp: new Date(match[1]).getTime(),
        level: match[2] as LogEntry["level"],
        jobId: match[3] || undefined,
        event: match[4] || undefined,
        message: match[5] ?? "",
      };
    });
    return parsed.filter((e): e is LogEntry => {
      if (!e) return false;
      if (level && LEVELS[e.level] < LEVELS[level]) return false;
      return true;
    });
  } catch {
    return [];
  }
}
