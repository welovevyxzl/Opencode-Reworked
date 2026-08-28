import { getDatabase } from "./index.js";

export interface ThreadSessionRow {
  threadId: string;
  sessionId: string;
  projectAlias: string;
  channelId: string;
}

export function getDatabaseRows(): ThreadSessionRow[] {
  const db = getDatabase();
  if (!db) return [];
  const rows = db.prepare("SELECT thread_id, session_id, project_alias, channel_id FROM thread_sessions").all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    threadId: r.thread_id as string,
    sessionId: r.session_id as string,
    projectAlias: r.project_alias as string,
    channelId: r.channel_id as string,
  }));
}