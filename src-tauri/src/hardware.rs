use crate::config::{save_config, ScaleConfig, StationConfig};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serialport::SerialPortType;
use std::io::{Read, Write};
use std::time::Duration;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    name: String,
    kind: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentResult {
    agent_id: String,
    tenant_id: String,
    name: String,
    station_label: String,
    token: String,
}

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|err| err.to_string())?;
    Ok(ports
        .into_iter()
        .map(|port| {
            let kind = match port.port_type {
                SerialPortType::UsbPort(info) => {
                    let product = info.product.unwrap_or_else(|| "USB Serial".to_string());
                    format!("USB {}", product)
                }
                SerialPortType::BluetoothPort => "Bluetooth".to_string(),
                SerialPortType::PciPort => "PCI".to_string(),
                SerialPortType::Unknown => "Serial".to_string(),
            };
            PortInfo { name: port.port_name, kind }
        })
        .collect())
}

pub fn parse_weight_frame(frame: &str, parser_regex: &str) -> Result<f64, String> {
    let regex = Regex::new(parser_regex).map_err(|err| format!("Regex invalido: {err}"))?;
    let captures = regex
        .captures(frame)
        .ok_or_else(|| "Frame nao contem peso no formato esperado.".to_string())?;
    let raw = captures
        .name("weight")
        .or_else(|| captures.get(1))
        .ok_or_else(|| "Regex precisa capturar o peso no grupo 1 ou no grupo nomeado weight.".to_string())?
        .as_str();
    raw.replace(',', ".")
        .trim()
        .parse::<f64>()
        .map_err(|err| format!("Peso invalido '{raw}': {err}"))
}

#[allow(dead_code)]
pub fn is_stable(samples: &[f64], threshold_kg: f64) -> bool {
    if samples.len() < 2 {
        return false;
    }
    let min = samples.iter().copied().fold(f64::INFINITY, f64::min);
    let max = samples.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (max - min).abs() <= threshold_kg
}

#[tauri::command]
pub fn test_scale_parse(frame: String, parser_regex: String) -> Result<f64, String> {
    parse_weight_frame(&frame, &parser_regex)
}

#[tauri::command]
pub fn read_scale_once(config: ScaleConfig) -> Result<f64, String> {
    if config.port.trim().is_empty() {
        return Err("Porta serial da balanca nao configurada.".to_string());
    }

    let mut builder = serialport::new(config.port.clone(), config.baud_rate).timeout(Duration::from_millis(1500));
    builder = builder.data_bits(match config.data_bits {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    });
    builder = builder.stop_bits(if config.stop_bits == 2 {
        serialport::StopBits::Two
    } else {
        serialport::StopBits::One
    });
    builder = builder.parity(match config.parity.as_str() {
        "odd" => serialport::Parity::Odd,
        "even" => serialport::Parity::Even,
        _ => serialport::Parity::None,
    });

    let mut port = builder.open().map_err(|err| err.to_string())?;
    if let Some(command) = config.read_command.as_ref().filter(|value| !value.is_empty()) {
        port.write_all(command.as_bytes()).map_err(|err| err.to_string())?;
    }
    let mut buffer = vec![0_u8; 256];
    let read = port.read(buffer.as_mut_slice()).map_err(|err| err.to_string())?;
    let frame = String::from_utf8_lossy(&buffer[..read]);
    parse_weight_frame(&frame, &config.parser_regex)
}

#[allow(dead_code)]
pub fn build_scale_device(config: &ScaleConfig) -> serde_json::Value {
    json!({
        "kind": "SCALE",
        "localId": config.port,
        "name": format!("Balanca {}", config.port),
        "status": if config.port.is_empty() { "OFFLINE" } else { "ONLINE" },
        "config": config
    })
}

#[tauri::command]
pub async fn enroll_agent(server_url: String, code: String, station_label: String) -> Result<EnrollmentResult, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/hardware/enroll", server_url.trim_end_matches('/'));
    let response = client
        .post(url)
        .json(&json!({ "code": code, "stationLabel": station_label }))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        return Err(body);
    }
    serde_json::from_str(&body).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn heartbeat_once(config: StationConfig) -> Result<serde_json::Value, String> {
    let token = config.token.clone().ok_or_else(|| "Agente ainda nao matriculado.".to_string())?;
    save_config(config.clone())?;
    let client = reqwest::Client::new();
    let url = format!("{}/api/hardware/agent/heartbeat", config.server_url.trim_end_matches('/'));
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&json!({
            "appVersion": config.app_version,
            "devices": [
                build_scale_device(&config.scale),
                {
                    "kind": "PRINTER",
                    "localId": config.printer.local_id,
                    "name": config.printer.queue_name.clone().or(config.printer.host.clone()).unwrap_or_else(|| "Impressora".to_string()),
                    "status": "ONLINE",
                    "config": config.printer
                }
            ]
        }))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        return Err(body);
    }
    serde_json::from_str(&body).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_toledo_like_frame() {
        let weight = parse_weight_frame("ST,GS,+0012.345kg", r"([-+]?\d+[\.,]?\d*)\s*kg?").unwrap();
        assert!((weight - 12.345).abs() < 0.0001);
    }

    #[test]
    fn parses_named_weight_group() {
        let weight = parse_weight_frame("PESO=18,740 KG", r"PESO=(?P<weight>\d+,\d+)").unwrap();
        assert!((weight - 18.740).abs() < 0.0001);
    }

    #[test]
    fn detects_stability_window() {
        assert!(is_stable(&[20.010, 20.015, 20.020], 0.02));
        assert!(!is_stable(&[20.010, 20.080, 20.020], 0.02));
    }
}
