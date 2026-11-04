export type Station =
  | "intent"
  | "spec"
  | "plan"
  | "test-plan"
  | "unit-tests"
  | "implementation"
  | "verify"
  | "publish";
export type ProviderName = "codex" | "claude" | "deepseek";
export interface Finding {
  id: string;
  rule: string;
  blocking: boolean;
  evidence: string;
  consequence: string;
  resolution: string;
}
export interface CheckDefinition {
  id: string;
  profile: string;
  files: string[];
  acIds: string[];
  required: boolean;
  expectation: "red" | "green";
}
export interface CheckResult {
  id: string;
  required: boolean;
  status: string;
  total?: number;
  failed?: number;
  reason?: string;
  sourceFingerprint?: string;
  evidence?: string;
  evidenceHashes?: Record<string, string>;
  acIds?: string[];
  observation?: string;
  durationMs?: number;
}
export interface ProviderMetrics {
  station?: Station;
  role?: "author" | "review";
  provider?: ProviderName;
  model?: string;
  attempt?: string;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  terminationReason?: string;
  spans?: Array<{ kind: "model" | "tool"; id: string; name?: string; startMs: number; durationMs?: number }>;
  durationMs: number;
  firstEventMs?: number;
  firstToolMs?: number;
  actionableOutputMs?: number;
  toolCount: number;
  usage?: Record<string, number>;
  tokens?: TokenMetrics;
}
export interface TokenStep {
  step: number;
  inputBytes: number;
  estimatedInputTokens: number;
  toolResultBytes: number;
  sectionBytes?: Record<string, number>;
  usage?: Record<string, number>;
  finish?: string;
}
export interface TokenMetrics {
  source: "dsh-llm-stream";
  counting: "utf8-bytes-div-3-estimate";
  kitchenPromptBytes?: number;
  adapterInputBytes?: number;
  adapterSections?: Record<string, number>;
  modelSteps: number;
  steps: TokenStep[];
  usageComplete: boolean;
  knownInputTokens: number;
  knownOutputTokens: number;
  knownTotalTokens: number;
  totalTokens?: number;
  toolResultBytes: number;
  terminationReason?: string;
  failure?: string;
  warnings: string[];
}
export interface RunMetrics {
  station?: Station;
  runId?: string;
  status?: StationRecord["status"];
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  humanWaitMs: number;
  firstActionableMs?: number;
  phases: Array<{ phase: string; durationMs: number }>;
  promptBytes: Array<{
    role: string;
    sections: Record<string, number>;
    total: number;
  }>;
  providers: ProviderMetrics[];
  discoveryCache?: { hits: number; misses: number };
  sourceSnapshots?: Array<{
    phase: string;
    fileCount: number;
    byteCount: number;
  }>;
}
export interface DiscoveryResult {
  summary: string;
  evidence: Array<{ path: string; line: number; hash: string }>;
  unresolved: string[];
}
export interface FileChange {
  path: string;
  action: "write" | "delete";
  content: string | null;
  kind: "test" | "scaffold" | "implementation" | "support";
}
export interface AuthorOutput {
  summary: string;
  questions: Array<{ id: string; text: string }>;
  document: string | null;
  files: FileChange[];
  allowedPaths: string[];
  unitTestFiles: string[];
  scaffoldFiles: string[];
  checks: CheckDefinition[];
}
export interface ReviewOutput {
  summary: string;
  findings: Finding[];
}
export interface DeepSeekOptions {
  version: string;
  baseURL: string;
  contextWindow: number;
  maxTokens: number;
  expectedModelDigest?: string;
  tokenPolicy?: DeepSeekTokenPolicy;
}
export interface DeepSeekTokenPolicy {
  version: 1;
  compactContext?: boolean;
  safetyMarginTokens?: number;
  toolHistoryReserveTokens?: number;
  maxSteps?: number;
  maxToolCalls?: number;
  maxToolResultBytes?: number;
  maxInputBytes?: number;
  outputTokens?: { probe?: number; review?: number; discovery?: number };
}
export interface RoleConfig {
  provider: ProviderName;
  model?: string;
  executable?: string;
  windowsSandbox?: "elevated" | "unelevated";
  dsh?: DeepSeekOptions;
  sessionReuse?: "never" | "after-input";
}
export interface Profile {
  version?: string;
  kind: "unit" | "integration" | "browser" | "command" | "manual";
  cwd?: string;
  command?: string;
  args?: string[];
  parser?: "vitest-json" | "playwright-json" | "exit-code";
  timeoutMs?: number;
  parallelSafe?: boolean;
  resourceGroup?: string;
  env?: Record<string, string>;
  fixture?: string;
  setup?: { command: string; args: string[]; timeoutMs: number };
  preview?: {
    command: string;
    args: string[];
    readyPath?: string;
    build: { command: string; args: string[] };
  };
}
export interface Config {
  version: number;
  base: string;
  github: { repository: string; account?: string };
  providers: { author: RoleConfig; review: RoleConfig; timeoutMs: number };
  stations: Partial<
    Record<
      Station,
      { author?: RoleConfig; review?: RoleConfig; reviewEnabled?: boolean }
    >
  >;
  profiles: Record<string, Profile>;
  discovery?: { enabled?: boolean; author?: RoleConfig };
}
export interface Approval {
  actor: string;
  at: string;
  fingerprint: string;
  resolutions: Record<string, string>;
  reviewMinutes?: number;
}
export interface StationRecord {
  authorSession?: AuthorSession;
  status:
    | "running"
    | "awaiting-input"
    | "awaiting-approval"
    | "approved"
    | "stale"
    | "failed";
  runId: string;
  rubricVersion: string;
  profileVersions: Record<string, string>;
  findings: Finding[];
  checks: CheckResult[];
  summary: string;
  artifactFiles: string[];
  output?: AuthorOutput;
  commit?: string;
  reviewFingerprint?: string;
  approval?: Approval;
  error?: string;
  metrics?: RunMetrics;
}
export interface AuthorSession {
  id: string;
  home: string;
  fingerprint: string;
  conversationLength: number;
}
export interface FeatureState {
  version: 1;
  feature: string;
  request: string;
  issue?: string;
  baseCommit: string;
  branch: string;
  worktree: string;
  stations: Partial<Record<Station, StationRecord>>;
  conversation: Array<{
    role: "operator" | "model";
    station: Station;
    text: string;
    at: string;
  }>;
  testsFirstCommit?: string;
  testRevisionCommits?: string[];
  testHashes?: Record<string, string>;
  scaffoldContents?: Record<string, string>;
  preparation?: {
    runId: string;
    artifact: string;
    sha256: string;
    status: "passed" | "failed";
  };
  pr?: string;
  discovery?: {
    codeFingerprint: string;
    specFingerprint?: string;
    policyFingerprint: string;
    results: DiscoveryResult[];
  };
}
export interface ProviderRequest {
  station: Station;
  role: "author" | "review";
  prompt: string;
  cwd: string;
  runDir: string;
  config: RoleConfig;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  kind?: "discovery";
  onMetrics?: (metrics: ProviderMetrics) => void;
  session?: { id?: string; home: string };
  onSession?: (id: string) => void;
  freshPrompt?: string;
}
export type Provider = (request: ProviderRequest) => Promise<unknown>;
export interface PrInput {
  repository: string;
  base: string;
  head: string;
  title: string;
  bodyFile: string;
}
export interface GitHubGateway {
  identity: () => Promise<string>;
  find: (repository: string, head: string) => Promise<string | null>;
  push: (cwd: string, branch: string) => Promise<void>;
  create: (input: PrInput) => Promise<string>;
}
export interface ManualObservation {
  id: string;
  observation: string;
  evidence: string[];
  status: "passed" | "failed" | "not-applicable";
  reason?: string;
}
