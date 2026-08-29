export interface Config {
  discord: {
    token: string;
    applicationId: string;
    guildId: string;
    ownerId: string;
    statusChannelId?: string;
  };
  opencode: {
    port: number;
    host: string;
    serverPassword: string;
    autoStart: boolean;
    portRangeMin?: number;
    portRangeMax?: number;
  };
  projects: {
    defaultDir: string;
    registered: RegisteredProject[];
  };
  github: {
    enabled: boolean;
  };
  voice: {
    enabled: boolean;
    openaiApiKey?: string;
  };
  queue: {
    continueOnFailure: boolean;
    freshContext: boolean;
    stallTimeoutMs?: number;
    maxJobTimeoutMs?: number;
  };
  startup: {
    bootWithWindows: boolean;
    mode?: "disabled" | "login" | "scheduled";
  };
}

export interface RegisteredProject {
  alias: string;
  path: string;
}

export interface ChannelBinding {
  channelId: string;
  projectAlias: string;
  /** inherit | enabled | disabled — how this channel/thread treats autocode relative to its parent */
  autocode: AutocodeMode;
  activeSessionId?: string;
  threadSessionMap: Map<string, string>;
  /** @deprecated legacy boolean representation */
  autocodeEnabled?: boolean;
}

export type AutocodeMode = "inherit" | "enabled" | "disabled";

export interface ProjectState {
  alias: string;
  path: string;
  selectedModel: string;
  threadSessionMap: Map<string, string>;
  autocodeEnabled: boolean;
  channelBindings: Map<string, ChannelBinding>;
}

export type JobStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = [
  "starting",
  "running",
  "cancelling",
] as const;

export type JobKind = "prompt" | "continuation" | "regen" | "task";

export interface QueueItem {
  id: string;
  prompt: string;
  title?: string;
  channelId: string;
  threadId: string;
  projectAlias: string;
  directory?: string;
  sessionId?: string;
  model?: string;
  kind: JobKind;
  taskId?: string;
  addedAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt?: number;
  heartbeatAt?: number;
  attemptCount: number;
  status: JobStatus;
  result?: string;
  error?: string;
  lastError?: string;
  workerId?: string;
}

export interface AllowlistEntry {
  userId: string;
  username: string;
  addedAt: number;
  addedBy: string;
  isOwner: boolean;
}

export interface SessionInfo {
  id: string;
  title?: string;
  project: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  isRunning: boolean;
  threadId?: string;
}

export interface GitStatus {
  branch: string;
  clean: boolean;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "error" | "warning";
  message: string;
  fix?: string;
}

export interface BotState {
  connected: boolean;
  opencodeHealthy: boolean;
  startTime: number;
  currentJobs: Map<string, string>;
  queueSize: number;
}

export interface LogEntry {
  timestamp: number;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  message: string;
  context?: string;
  data?: unknown;
  jobId?: string;
  event?: string;
}

/** Autopilot task record (persisted in SQLite). */
export type TaskMode = "normal" | "autopilot";
export type TaskStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskRecord {
  id: string;
  prompt: string;
  projectAlias: string;
  directory?: string;
  channelId?: string;
  threadId?: string;
  sessionId?: string;
  mode: TaskMode;
  status: TaskStatus;
  maxIterations: number;
  iteration: number;
  /** JSON blob: objective, remaining work, verification snapshot, failure fingerprint */
  stateJson?: string;
  createdAt: number;
  updatedAt: number;
}

/** Durable pending component actions (confirmations, commit prompts). */
export interface PendingAction {
  id: string;
  type: string;
  channelId?: string;
  projectAlias?: string;
  payloadJson?: string;
  requesterId: string;
  createdAt: number;
  expiresAt: number;
}
