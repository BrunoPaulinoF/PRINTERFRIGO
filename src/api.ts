import { invoke } from "@tauri-apps/api/core";
import type {
  AdminSession,
  AdminStatus,
  AiLocalSnapshot,
  EnrollmentResult,
  LocalToolResult,
  PortInfo,
  PrinterConfig,
  PrinterInfo,
  RealtimeTokenResult,
  StationConfig,
} from "./types";

export function loadConfig(): Promise<StationConfig | null> {
  return invoke("load_config");
}

export function saveConfig(config: StationConfig): Promise<void> {
  return invoke("save_config", { config });
}

export function enrollAgent(serverUrl: string, code: string, stationLabel: string): Promise<EnrollmentResult> {
  return invoke("enroll_agent", { serverUrl, code, stationLabel });
}

export function listSerialPorts(): Promise<PortInfo[]> {
  return invoke("list_serial_ports");
}

export function listPrinters(): Promise<PrinterInfo[]> {
  return invoke("list_printers");
}

export function testScaleParse(frame: string, parserRegex: string): Promise<number> {
  return invoke("test_scale_parse", { frame, parserRegex });
}

export function readScaleOnce(config: StationConfig["scale"]): Promise<number> {
  return invoke("read_scale_once", { config });
}

export function testPrintZpl(printer: PrinterConfig, zpl: string): Promise<string> {
  return invoke("test_print_zpl", { printer, zpl });
}

export function heartbeatOnce(config: StationConfig): Promise<unknown> {
  return invoke("heartbeat_once", { config });
}

export async function fetchRealtimeToken(config: StationConfig): Promise<RealtimeTokenResult> {
  return invoke("fetch_realtime_token", { config });
}

export function submitCapture(
  config: StationConfig,
  request: {
    captureId: string;
    sessionId: string;
    pointId: string;
    flow: "RECEIVING" | "OP_OUTPUT";
    grossWeight: number;
    stable: boolean;
    payload: Record<string, unknown>;
  },
): Promise<unknown> {
  return invoke("submit_capture", { config, request });
}

export function reportPrintJob(
  config: StationConfig,
  request: { jobId: string; status: "PRINTED" | "FAILED"; error?: string },
): Promise<unknown> {
  return invoke("report_print_job", { config, request });
}

export function adminLogin(password: string): Promise<AdminSession> {
  return invoke("admin_login", { password });
}

export function adminLogout(token: string): Promise<void> {
  return invoke("admin_logout", { token });
}

export function adminStatus(token?: string): Promise<AdminStatus> {
  return invoke("admin_status", { token });
}

export function ensureWindowsAutostart(): Promise<string> {
  return invoke("ensure_windows_autostart");
}

export function aiCollectSnapshot(token: string, draftConfig: StationConfig): Promise<AiLocalSnapshot> {
  return invoke("ai_collect_snapshot", { token, draftConfig });
}

export function aiRunLocalTool(token: string, tool: string, args: Record<string, unknown> = {}): Promise<LocalToolResult> {
  return invoke("ai_run_local_tool", { token, request: { tool, args } });
}

export function aiSaveStationConfig(token: string, config: StationConfig): Promise<void> {
  return invoke("ai_save_station_config", { token, config });
}
