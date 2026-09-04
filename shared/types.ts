export type Agent = 'claude' | 'codex';

export type Status = 'working' | 'waiting' | 'ended' | 'idle';

export interface LiveTmux {
  kind: 'tmux';
  tmux: string;        // tmux session name
  dead: boolean;       // pane exited (remain-on-exit)
  pid?: number;
}
export interface LiveExternal {
  kind: 'external';
  pid: number;
  tty?: string;
}

export interface Session {
  key: string;         // `${agent}:${id}`
  id: string;
  agent: Agent;
  cwd: string;
  project: string;     // display name for the cwd
  title: string;
  firstPrompt: string;
  lastPrompt?: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  gitBranch?: string;
  version?: string;
  transcriptPath?: string;
  importedFrom?: { agent: Agent; id: string };
  archived?: boolean;
  live?: LiveTmux | LiveExternal;
  status: Status;
  agentName?: string;  // claude's own session name (e.g. fpl-72)
}

export interface Project {
  cwd: string;
  name: string;
  sessions: string[];  // session keys, sorted by updatedAt desc
  updatedAt: number;
  liveCount: number;
}

export interface Snapshot {
  generatedAt: number;
  sessions: Session[];
  projects: Project[];
  pending: PendingLaunch[];
}

export interface PendingLaunch {
  tmux: string;
  agent: Agent;
  cwd: string;
  startedAt: number;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; name: string; input: string }
  | { type: 'tool_result'; text: string; isError?: boolean };

export interface Message {
  role: 'user' | 'assistant' | 'system';
  ts?: number;
  blocks: Block[];
}

export interface Settings {
  claudeArgs: string[];
  codexArgs: string[];
  showImported: boolean;
  extraProjectDirs: string[];
}

export interface SessionStats {
  contextTokens?: number;      // tokens in the model's context at the last turn
  contextWindow?: number;      // model context window; estimated for Claude
  contextEstimated?: boolean;
  outputTokens?: number;       // total generated across the session
  turns: number;               // real user prompts
  assistantMessages: number;
  toolCalls: number;
  filesTouched: number;        // distinct files edited or written
  subagents: number;
  compactions: number;
  firstAt?: number;
  lastAt?: number;
  activeMs: number;            // time between messages, ignoring gaps over 30 minutes
  bytes?: number;              // transcript size on disk
}

export interface TranscriptResponse { messages: Message[]; stats: SessionStats }
