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
