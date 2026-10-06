export type Agent = 'claude' | 'codex';

/** `looping`: waiting at the prompt, but a /loop wakeup or cron job will start the next turn by itself. */
export type Status = 'working' | 'waiting' | 'looping' | 'ended' | 'idle';

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
  context?: SessionContext;  // context window fill after the last turn, from the transcript tail
  loop?: SessionLoop;        // a /loop (or other scheduled prompt) armed in this live Claude process
}

/** What Claude's own scheduler will run next, read from ScheduleWakeup / CronCreate calls in the transcript. */
export interface SessionLoop {
  kind: 'self-paced' | 'cron';
  prompt: string;      // what each tick runs; '' for an autonomous loop
  ticks: number;       // turns the loop has run (a lower bound if it started before the transcript tail Tower read)
  startedAt?: number;
  lastAt?: number;     // when the last tick was scheduled (self-paced) or fired (cron)
  nextAt?: number;     // self-paced: when the next wakeup fires
  reason?: string;     // self-paced: why the model picked that delay
  quiet?: number;      // self-paced: trailing ticks the model marked noop (nothing changed)
  schedule?: string;   // cron: human schedule ("Every 5 minutes") or the raw cron expression
  jobs?: number;       // scheduled cron jobs in this process, when there is more than one
}

export interface SessionContext {
  tokens: number;      // tokens the model saw on its last call
  window: number;      // model context window
  estimated: boolean;  // window guessed from the model name (Claude) rather than reported (Codex)
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
  extraDirs: ProjectDir[];          // folders from settings, listed even without sessions
  pending: PendingLaunch[];
  renamed: Record<string, string>;  // old tmux name -> current name, for panes that moved
  workspaces?: WorkspaceSummary[];  // the Mac's workspaces, mirrored for the phone
}

export interface ProjectDir { cwd: string; name: string }

/**
 * What /ws/events?v=2 sends: the whole snapshot on connect, then only what changed. Fields other than
 * the session lists are present only when they changed; projects are derived on the client.
 */
export interface SnapshotDelta {
  generatedAt: number;
  upsert: Session[];
  remove: string[];                 // session keys
  extraDirs?: ProjectDir[];
  pending?: PendingLaunch[];
  renamed?: Record<string, string>;
  workspaces?: WorkspaceSummary[];
}

export type SnapshotEvent = { t: 'full'; snapshot: Snapshot } | ({ t: 'delta' } & SnapshotDelta);

export interface WorkspaceSummary {
  id: string;
  name: string;
  panes: string[];     // tmux names, in grid order
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
  remoteEnabled: boolean;
  remotePort: number;
  remoteAllowLan: boolean;       // also accept private LAN addresses, not only Tailscale
  trustFolders: boolean;         // mark a folder trusted for Claude before launching there, so it never asks
}

export interface RemoteUrl {
  kind: 'tailscale' | 'lan';
  label: string;
  url: string;
  pairUrl: string;               // url + /pair?t=<token>; opening it pairs the device
  qrSvg: string;
}

export interface RemoteInfo {
  enabled: boolean;
  listening: boolean;
  port: number;
  error: string;
  tailscale: boolean;            // this Mac has a Tailscale address
  urls: RemoteUrl[];
  connected: number;             // remote devices with the app open right now
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

export type DoctorId = 'tmux' | 'claude' | 'codex' | 'sqlite3';

export interface DoctorCheck {
  id: DoctorId;
  label: string;
  required: boolean;   // the app cannot work without it
  found: boolean;
  path?: string;       // resolved executable on the login PATH
  version?: string;    // first line of `--version` / `-V`
  hint: string;        // the exact command that fixes a missing tool
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;         // every required tool found and at least one agent CLI present
  path: string;        // PATH as Tower sees it (login shell)
  shell: string;
}
