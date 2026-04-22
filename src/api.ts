import { invoke } from "@tauri-apps/api/core";
import type { EnrollmentResult, PortInfo, PrinterConfig, StationConfig } from "./types";

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

export function listPrinters(): Promise<string[]> {
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
