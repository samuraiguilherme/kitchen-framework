export type Station =
  | "intent"
  | "spec"
  | "plan"
  | "test-plan"
  | "unit-tests"
  | "implementation"
  | "verify"
  | "publish";
export type ProviderName = "codex" | "claude";
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
export interface RoleConfig {
  provider: ProviderName;
  model?: string;
  executable?: string;
  windowsSandbox?: "elevated" | "unelevated";
}
export interface Profile {
  version?: string;
  kind: "unit" | "integration" | "browser" | "command" | "manual";
  cwd?: string;
  command?: string;
  args?: string[];
  parser?: "vitest-json" | "playwright-json" | "exit-code";
  timeoutMs?: number;
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
    Record<Station, { author?: RoleConfig; review?: RoleConfig }>
  >;
  profiles: Record<string, Profile>;
}
export interface Approval {
  actor: string;
  at: string;
  fingerprint: string;
  resolutions: Record<string, string>;
  reviewMinutes?: number;
}
export interface StationRecord {
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
  reviewFingerprint?: string;
  approval?: Approval;
  error?: string;
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
  pr?: string;
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
