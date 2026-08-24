// KS SSH shared contracts — single source of truth for web ↔ server.
// Server JSON shapes and WebSocket envelopes MUST match these types.

export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
  totpEnabled: boolean;
  createdAt: string;
}

export interface HostGroup {
  id: number;
  name: string;
  color: string;
}

export type AuthType = 'password' | 'key' | 'key_passphrase' | 'agent';

export interface Host {
  id: number;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  groupId: number | null;
  labels: string[];
  color: string;
  jumpHostId: number | null;
  maxSessions: number;
  previewEnabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

// Never contains secrets; secrets are write-only.
export interface HostInput {
  name: string;
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  groupId?: number | null;
  labels?: string[];
  color?: string;
  jumpHostId?: number | null;
  maxSessions?: number;
  previewEnabled?: boolean;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  latencyMs: number;
}

export interface KnownHostPrompt {
  fingerprint: string;
  knownBefore: boolean;      // true if stored fingerprint differs
  storedFingerprint?: string;
}

// ---- WebSocket envelope (all sockets) ----
export interface Envelope<T = unknown> {
  type: string;
  seq: number;
  ts: number; // unix ms
  payload: T;
}

// Terminal
export type PtyIn = { data: string };
export type PtyResize = { cols: number; rows: number };
export type PtyOut = { data: string };
export type PtyReplayChunk = { data: string; firstSeq: number; lastSeq: number; truncated: boolean };
export type PtyAttached = {
  sessionId: string;
  hostId: number;
  replayedFromSeq: number;
};
export type PingResult = { rttMs: number | null };

// Files / SFTP
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  symlinkTarget?: string;
  size: number;
  mode: string;       // octal, e.g. "0644"
  perms: string;      // rwxr-xr-x
  owner: string;
  group: string;
  modTime: string;    // ISO
  itemType: FileType;
}

export type FileType =
  | 'folder' | 'file'
  | 'js' | 'ts' | 'jsx' | 'tsx' | 'py' | 'go' | 'json' | 'yml' | 'yaml'
  | 'html' | 'css' | 'scss' | 'sh' | 'md' | 'zip' | 'tar' | 'gz' | 'img'
  | 'pdf' | 'mp3' | 'mp4' | 'log' | 'conf' | 'sql' | 'rs' | 'java' | 'c'
  | 'cpp' | 'php' | 'rb' | 'xml' | 'csv' | 'lock';

export interface ListReq { path: string }
export interface MkdirReq { path: string }
export interface RenameReq { from: string; to: string }
export interface CopyReq { from: string; to: string }
export interface DeleteReq { paths: string[] }
export interface ChmodReq { path: string; mode: string }
export interface SearchFilesReq { root: string; pattern: string }

// Transfers (WS)
export type TransferStart = {
  transferId: string;
  kind: 'upload' | 'download';
  path: string;
  name: string;
  size: number;
};
export type TransferProgress = {
  transferId: string;
  transferred: number;
  total: number;
  speedBps: number;
  status: 'active' | 'paused' | 'done' | 'error' | 'queued';
  error?: string;
};
export type UploadChunk = {
  transferId: string;
  index: number;
  dataBase64: string;
  checksum: string; // sha256 hex of chunk
  final: boolean;
};
export type UploadAck = { transferId: string; index: number; ok: boolean; error?: string };

// Editor
export interface OpenFileResult {
  path: string;
  content: string;
  language: string;
  size: number;
  readOnly: boolean;
  mtimeMs: number;
}
export interface SaveFileReq {
  path: string;
  content: string;
  expectedMtimeMs?: number; // optimistic concurrency; conflict => 409
}
export interface DiffReq { path: string; content: string }
export interface DiffResult { unified: string; changed: boolean }
export interface BackupInfo { id: number; path: string; createdAt: string; size: number }

// Ports
export interface PortRow {
  protocol: 'tcp' | 'udp';
  port: number;
  bindAddress: string;
  pid: number | null;
  process: string;
}
export interface KillReq { pid: number; port: number }

// Preview proxy
export interface PreviewStatus { enabled: boolean; baseUrl: string }

// Tunnels
export type TunnelKind = 'L' | 'R' | 'D';
export interface Tunnel {
  id: number;
  hostId: number;
  kind: TunnelKind;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
  status: 'stopped' | 'starting' | 'up' | 'error';
  error?: string;
  bytesUp: number;
  bytesDown: number;
  connections: number;
}
export interface TunnelInput {
  hostId: number;
  kind: TunnelKind;
  localHost?: string;
  localPort: number;
  remoteHost?: string;
  remotePort?: number;
  autoStart?: boolean;
}

// Monitor
export interface MetricSample {
  ts: number;
  cpuPercent: number;
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  diskTotal: number;
  diskUsed: number;
  netRx: number; // bytes/s
  netTx: number;
  load1: number;
  load5: number;
  load15: number;
  uptimeSec: number;
}
export interface ProcessRow {
  pid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  memBytes: number;
  command: string;
}
export interface SystemInfo {
  hostname: string;
  os: string;
  osVersion: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  ramTotal: number;
  diskTotal: number;
  virtualization: string;
  publicIp: string | null;
  distro: string;
  uptimeSec: number;
}

// Snippets
export interface Snippet {
  id: number;
  name: string;
  command: string;
  hostId: number | null; // null = global
  dangerous: boolean;
}
export interface MultiExecTarget { hostId: number }
export type MultiExecEvent =
  | { hostId: number; stream: 'stdout' | 'stderr'; data: string }
  | { hostId: number; exitCode: number | null; done: true };

// Git
export interface GitFile { path: string; x: string; y: string } // porcelain XY
export interface GitStatus { branch: string; ahead: number; behind: number; files: GitFile[] }
export interface GitLogEntry { hash: string; author: string; date: string; subject: string }

// Docker
export interface DockerContainer {
  id: string;
  names: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

// Services (systemd)
export interface ServiceUnit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

// Cron
export interface CronLine { line: string; comment: boolean }

// Sessions & audit
export interface SessionRecord {
  id: number;
  username: string;
  hostName: string;
  kind: string;
  startedAt: string;
  endedAt: string | null;
}
export interface AuditEntry {
  id: number;
  username: string;
  action: string;
  target: string;
  hostName: string;
  result: string;
  detail: string;
  at: string;
}
export interface Recording {
  id: number;
  sessionId: string;
  hostName: string;
  startedAt: string;
  durationSec: number;
  sizeBytes: number;
}

// Bookmarks
export interface Bookmark {
  id: number;
  hostId: number;
  path: string;
  label: string;
  kind: 'path' | 'file';
}

// Settings
export interface AppSettings {
  theme: 'dark' | 'light';
  accentColor: string;
  terminalTheme: string;
  fontSize: number;
  keyBarDefault: boolean;
  autoSaveEditor: boolean;
  recordingEnabled: boolean;
  enablePreviewDefault: boolean;
  keepBackupVersions: number;
  notificationPrefs: Record<string, boolean>;
}

// Global search
export interface SearchHit {
  path: string;
  line: number;
  text: string;
}
export interface GlobalSearchReq {
  hostId: number;
  root: string;
  query: string;
  replace?: string;
  doReplace?: boolean;
  caseSensitive?: boolean;
  includeGlob?: string;
}

// Notifications
export interface Notification {
  id: string;
  level: 'info' | 'warn' | 'error';
  title: string;
  body: string;
  at: number;
  read: boolean;
}

// API errors
export interface ApiError { error: string }

// Auth
export interface LoginReq { username: string; password: string; totp?: string }
export interface LoginRes { user: User; needsTotp?: boolean }
