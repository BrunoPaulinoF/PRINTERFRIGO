export type ScaleConfig = {
  port: string;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: "none" | "odd" | "even";
  readCommand?: string;
  parserRegex: string;
  stableWindow: number;
  stableThresholdKg: number;
  stableMs: number;
  minWeightKg: number;
  cooldownMs: number;
  zeroThresholdKg: number;
};

export type PrinterConfig = {
  mode: "windows_spooler" | "tcp_9100" | "dry_run";
  localId: string;
  queueName?: string;
  host?: string;
  port?: number;
  dryRunDir?: string;
};

export type StationConfig = {
  serverUrl: string;
  agentId?: string;
  tenantId?: string;
  token?: string;
  stationLabel: string;
  appVersion: string;
  scale: ScaleConfig;
  printer: PrinterConfig;
  scales?: ScaleConfig[];
  printers?: PrinterConfig[];
};

export type EnrollmentResult = {
  agentId: string;
  tenantId: string;
  name: string;
  stationLabel: string;
  token: string;
};

export type PortInfo = {
  name: string;
  kind: string;
};

export type AdminSession = {
  token: string;
  expiresAtMs: number;
};

export type AdminStatus = {
  authenticated: boolean;
  expiresAtMs?: number;
};

export type AiLocalSnapshot = {
  savedConfig?: StationConfig | null;
  draftConfig?: StationConfig | null;
  serialPorts: unknown;
  printers: unknown;
  printJobs: unknown;
  services: unknown;
};

export type AiProposedAction = {
  id: string;
  label: string;
  tool: string;
  args?: Record<string, unknown>;
  requiresConfirmation?: boolean;
};

export type AiChatResponse = {
  reply: string;
  proposedActions: AiProposedAction[];
};

export type LocalToolResult = {
  ok: boolean;
  message: string;
  data: unknown;
};
