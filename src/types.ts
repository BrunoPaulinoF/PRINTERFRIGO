export type ScaleConfig = {
  mode?: "serial" | "simulated" | "tcp";
  port: string;
  host?: string;
  simulatedWeightKg?: number;
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

export type PrinterInfo = {
  name: string;
  isDefault: boolean;
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

export type RealtimeTokenResult = {
  ok: boolean;
  supabaseUrl: string;
  publishableKey: string;
  token: string;
  expiresAt: string;
  expiresInSeconds: number;
  agentId: string;
  tenantId: string;
};

export type PortInfo = {
  name: string;
  kind: string;
};

export type LocalLogEntry = {
  id: number;
  level: string;
  message: string;
  context?: string | null;
  createdAt: string;
};

export type AutoConfigureAttempt = {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string;
  command: string;
  parserRegex: string;
  gotData: boolean;
  weightKg: number | null;
  reason: string | null;
  frame: string;
  error: string | null;
};

export type AutoConfigureResult = {
  ok: boolean;
  message: string;
  config: ScaleConfig | null;
  weightKg: number | null;
  frame: string | null;
  parserLabel: string | null;
  parserRegex: string | null;
  attempts: AutoConfigureAttempt[];
  likelyCauses: string[];
  triedPorts: string[];
};
