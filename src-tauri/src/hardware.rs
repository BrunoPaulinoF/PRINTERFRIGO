use crate::config::{save_config, ScaleConfig, StationConfig};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serialport::SerialPortType;
use std::io::{Read, Write};
use std::net::TcpStream;
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    capture_id: String,
    session_id: String,
    point_id: String,
    flow: String,
    gross_weight: f64,
    stable: bool,
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintJobStatusRequest {
    job_id: String,
    status: String,
    error: Option<String>,
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
    if config.mode.as_deref() == Some("simulated") {
        let weight = config.simulated_weight_kg.unwrap_or(12.345);
        if weight <= 0.0 {
            return Err("Peso simulado precisa ser maior que zero.".to_string());
        }
        return Ok(weight);
    }

    if config.mode.as_deref() == Some("tcp") {
        let host = config.host.as_ref().filter(|h| !h.is_empty()).ok_or("Host TCP da balanca nao configurado.".to_string())?;
        let port = if config.port.is_empty() { "4001".to_string() } else { config.port.clone() };
        let port_num = port.parse::<u16>().map_err(|_| format!("Porta TCP invalida: {port}"))?;
        
        let mut stream = TcpStream::connect((host.as_str(), port_num))
            .map_err(|err| format!("Falha ao conectar na balanca TCP {host}:{port_num}: {err}"))?;
        stream.set_read_timeout(Some(Duration::from_millis(1500)))
            .map_err(|err| err.to_string())?;
        
        if let Some(command) = config.read_command.as_ref().filter(|value| !value.is_empty()) {
            let bytes = if command.ends_with('\n') {
                command.as_bytes().to_vec()
            } else {
                format!("{}\r\n", command).into_bytes()
            };
            stream.write_all(&bytes).map_err(|err| err.to_string())?;
        }
        
        let mut buffer = vec![0_u8; 256];
        let read = stream.read(buffer.as_mut_slice()).map_err(|err| err.to_string())?;
        let frame = String::from_utf8_lossy(&buffer[..read]);
        return parse_weight_frame(&frame, &config.parser_regex);
    }

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
        let bytes = if command.ends_with('\n') {
            command.as_bytes().to_vec()
        } else {
            format!("{}\r\n", command).into_bytes()
        };
        port.write_all(&bytes).map_err(|err| err.to_string())?;
    }
    let mut buffer = vec![0_u8; 256];
    let read = port.read(buffer.as_mut_slice()).map_err(|err| err.to_string())?;
    let frame = String::from_utf8_lossy(&buffer[..read]);
    parse_weight_frame(&frame, &config.parser_regex)
}

#[tauri::command]
pub fn read_scale_raw(config: ScaleConfig) -> Result<String, String> {
    if config.mode.as_deref() == Some("simulated") {
        return Ok(format!("SIMULATED: {} kg", config.simulated_weight_kg.unwrap_or(12.345)));
    }

    if config.mode.as_deref() == Some("tcp") {
        let host = config.host.as_ref().filter(|h| !h.is_empty()).ok_or("Host TCP da balanca nao configurado.".to_string())?;
        let port = if config.port.is_empty() { "4001".to_string() } else { config.port.clone() };
        let port_num = port.parse::<u16>().map_err(|_| format!("Porta TCP invalida: {port}"))?;
        
        let mut stream = TcpStream::connect((host.as_str(), port_num))
            .map_err(|err| format!("Falha ao conectar na balanca TCP {host}:{port_num}: {err}"))?;
        stream.set_read_timeout(Some(Duration::from_millis(3000)))
            .map_err(|err| err.to_string())?;
        
        if let Some(command) = config.read_command.as_ref().filter(|value| !value.is_empty()) {
            let bytes = if command.ends_with('\n') {
                command.as_bytes().to_vec()
            } else {
                format!("{}\r\n", command).into_bytes()
            };
            stream.write_all(&bytes).map_err(|err| err.to_string())?;
        }
        
        let mut buffer = vec![0_u8; 512];
        let read = stream.read(buffer.as_mut_slice()).map_err(|err| err.to_string())?;
        let frame = String::from_utf8_lossy(&buffer[..read]);
        return Ok(frame.to_string());
    }

    if config.port.trim().is_empty() {
        return Err("Porta serial da balanca nao configurada.".to_string());
    }

    let mut builder = serialport::new(config.port.clone(), config.baud_rate).timeout(Duration::from_millis(3000));
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
        let bytes = if command.ends_with('\n') {
            command.as_bytes().to_vec()
        } else {
            format!("{}\r\n", command).into_bytes()
        };
        port.write_all(&bytes).map_err(|err| err.to_string())?;
    }
    let mut buffer = vec![0_u8; 512];
    let read = port.read(buffer.as_mut_slice()).map_err(|err| err.to_string())?;
    let frame = String::from_utf8_lossy(&buffer[..read]);
    Ok(frame.to_string())
}

#[allow(dead_code)]
pub fn build_scale_device(config: &ScaleConfig) -> serde_json::Value {
    let simulated = config.mode.as_deref() == Some("simulated");
    let tcp = config.mode.as_deref() == Some("tcp");
    let local_id = if tcp {
        format!("{}:{}", config.host.as_deref().unwrap_or(""), config.port)
    } else {
        config.port.clone()
    };
    json!({
        "kind": "SCALE",
        "localId": local_id,
        "name": if simulated {
            format!("Balanca simulada {}", config.port)
        } else if tcp {
            format!("Balanca TCP {}", local_id)
        } else {
            format!("Balanca {}", config.port)
        },
        "status": if config.port.is_empty() && !tcp { "OFFLINE" } else { "ONLINE" },
        "config": config
    })
}

pub fn configured_scales(config: &StationConfig) -> Vec<ScaleConfig> {
    let mut scales = if config.scales.is_empty() { vec![config.scale.clone()] } else { config.scales.clone() };
    if !scales.iter().any(|scale| scale.port == config.scale.port) {
        scales.insert(0, config.scale.clone());
    }
    scales
}

pub fn configured_printers(config: &StationConfig) -> Vec<crate::config::PrinterConfig> {
    let mut printers = if config.printers.is_empty() { vec![config.printer.clone()] } else { config.printers.clone() };
    if !printers.iter().any(|printer| printer.local_id == config.printer.local_id) {
        printers.insert(0, config.printer.clone());
    }
    printers
}

#[tauri::command]
pub async fn enroll_agent(server_url: String, code: String, station_label: String) -> Result<EnrollmentResult, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/hardware/enroll", server_url.trim_end_matches('/'));
    let response = client
        .post(url)
        .json(&json!({ "code": code, "name": station_label, "stationLabel": station_label }))
        .send()
        .await
        .map_err(|err| format!("Nao foi possivel conectar ao KyberFrigo: {err}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.get("error").and_then(|error| error.as_str()).map(str::to_string))
            .unwrap_or(body);
        return Err(message);
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
            "devices": configured_scales(&config)
                .into_iter()
                .map(|scale| build_scale_device(&scale))
                .chain(configured_printers(&config).into_iter().map(|printer| json!({
                    "kind": "PRINTER",
                    "localId": printer.local_id,
                    "name": printer.queue_name.clone().or(printer.host.clone()).unwrap_or_else(|| "Impressora".to_string()),
                    "status": "ONLINE",
                    "config": printer
                })))
                .collect::<Vec<_>>()
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

#[tauri::command]
pub async fn fetch_realtime_token(config: StationConfig) -> Result<serde_json::Value, String> {
    let token = config.token.clone().ok_or_else(|| "Agente ainda nao matriculado.".to_string())?;
    let client = reqwest::Client::new();
    let url = format!("{}/api/hardware/agent/realtime-token", config.server_url.trim_end_matches('/'));
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .map_err(|err| format!("Nao foi possivel conectar ao KyberFrigo para Realtime: {err}"))?;
    parse_json_response(response).await
}

#[tauri::command]
pub async fn submit_capture(config: StationConfig, request: CaptureRequest) -> Result<serde_json::Value, String> {
    let token = config.token.clone().ok_or_else(|| "Agente ainda nao matriculado.".to_string())?;
    let client = reqwest::Client::new();
    let url = format!("{}/api/hardware/agent/captures", config.server_url.trim_end_matches('/'));
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&json!({
            "captureId": request.capture_id,
            "sessionId": request.session_id,
            "pointId": request.point_id,
            "flow": request.flow,
            "grossWeight": request.gross_weight,
            "stable": request.stable,
            "payload": request.payload,
        }))
        .send()
        .await
        .map_err(|err| format!("Nao foi possivel enviar captura ao KyberFrigo: {err}"))?;
    parse_json_response(response).await
}

#[tauri::command]
pub async fn report_print_job(config: StationConfig, request: PrintJobStatusRequest) -> Result<serde_json::Value, String> {
    let token = config.token.clone().ok_or_else(|| "Agente ainda nao matriculado.".to_string())?;
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/hardware/agent/print-jobs/{}",
        config.server_url.trim_end_matches('/'),
        request.job_id
    );
    let response = client
        .patch(url)
        .bearer_auth(token)
        .json(&json!({ "status": request.status, "error": request.error }))
        .send()
        .await
        .map_err(|err| format!("Nao foi possivel atualizar job de impressao: {err}"))?;
    parse_json_response(response).await
}

async fn parse_json_response(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = response.text().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.get("error").and_then(|error| error.as_str()).map(str::to_string))
            .unwrap_or(body);
        return Err(message);
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

    #[test]
    fn reads_simulated_scale() {
        let config = ScaleConfig {
            mode: Some("simulated".to_string()),
            port: "Balanca 1".to_string(),
            host: None,
            simulated_weight_kg: Some(12.345),
            baud_rate: 9600,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".to_string(),
            read_command: None,
            parser_regex: r"([-+]?\d+[\.,]?\d*)\s*kg?".to_string(),
            stable_window: 5,
            stable_threshold_kg: 0.02,
            stable_ms: 1200,
            min_weight_kg: 1.0,
            cooldown_ms: 1500,
            zero_threshold_kg: 0.25,
        };
        let weight = read_scale_once(config).unwrap();
        assert!((weight - 12.345).abs() < 0.0001);
    }
}
