import { invoke } from "@tauri-apps/api/core";
import type {
  AutoConfigureResult,
  EnrollmentResult,
  LocalLogEntry,
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

export function readScaleRaw(config: StationConfig["scale"]): Promise<string> {
  return invoke("read_scale_raw", { config });
}

export function autoConfigureScaleSerial(config: StationConfig["scale"]): Promise<AutoConfigureResult> {
  return invoke("auto_configure_scale_serial", { config });
}

export function testPrintZpl(printer: PrinterConfig, zpl: string): Promise<string> {
  return invoke("test_print_zpl", { printer, zpl });
}

export function quickResetPrinters(): Promise<string> {
  return invoke("quick_reset_printers");
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

export function ensureWindowsAutostart(): Promise<string> {
  return invoke("ensure_windows_autostart");
}

export function writeLocalLog(level: string, message: string, context?: Record<string, unknown>): Promise<void> {
  return invoke("write_local_log", { level, message, context });
}

export function listLocalLogs(limit = 50): Promise<LocalLogEntry[]> {
  return invoke("list_local_logs", { limit });
}
