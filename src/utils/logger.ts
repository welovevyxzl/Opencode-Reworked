import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { LogEntry } from "../types/index.js";

const REDACT_PATTERNS = [
  /discord[-_]?token[:\s]*["']?([A-Za-z0-9._-]{20,})["']?/gi,
  /(?:api[-_]?key|openai[-_]?key|OPENAI_API_KEY)[:\s]*["']?([A-Za-z0-9._-]{20,})["']?/gi,
  /(?:gho|ghp|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/gi,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /(?:password|serverPassword)[:\s]*["']?([^\s"']{8,})["']?/gi,
];

function redact(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const redacted = match.slice(0, 10) + "***REDACTED***";
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
  const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
  const line = redact(`${timestamp} ${entry.level.padEnd(5)} ${context} ${entry.message}${dataStr}\n`);

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

export function getRecentLogs(lines: number = 50, level?: LogEntry["level"]): LogEntry[] {
  if (!logFilePath || !existsSync(logFilePath)) return [];
  try {
    const content = readFileSync(logFilePath, "utf-8");
    const allLines = content.split("\n").filter((l) => l.trim());
    const recent = allLines.slice(-lines);
    return recent
      .map((line) => {
        const match = line.match(/^(\S+)\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)/);
        if (!match) return null;
        return {
          timestamp: new Date(match[1]).getTime(),
          level: match[2] as LogEntry["level"],
          message: match[3],
        };
      })
      .filter((e): e is LogEntry => {
        if (!e) return false;
        if (level && LEVELS[e.level] < LEVELS[level]) return false;
        return true;
      });
  } catch {
    return [];
  }
}
