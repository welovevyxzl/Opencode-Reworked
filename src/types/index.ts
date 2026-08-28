export interface Config {
  discord: {
    token: string;
    applicationId: string;
    guildId: string;
    ownerId: string;
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
  };
}

export interface RegisteredProject {
  alias: string;
  path: string;
}

export interface ChannelBinding {
  channelId: string;
  projectAlias: string;
  autocodeEnabled: boolean;
  activeSessionId?: string;
  threadSessionMap: Map<string, string>;
}

export interface ProjectState {
  alias: string;
  path: string;
  selectedModel: string;
  threadSessionMap: Map<string, string>;
  autocodeEnabled: boolean;
  channelBindings: Map<string, ChannelBinding>;
}

export interface QueueItem {
  id: string;
  prompt: string;
  channelId: string;
  threadId: string;
  projectAlias: string;
  sessionId?: string;
  addedAt: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
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
}
