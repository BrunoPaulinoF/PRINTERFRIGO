use crate::config::{save_config, ScaleConfig, StationConfig};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serialport::{SerialPort, SerialPortType};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

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
            PortInfo {
                name: port.port_name,
                kind,
            }
        })
        .collect())
}

pub fn parse_weight_frame(frame: &str, parser_regex: &str) -> Result<f64, String> {
    let parser = parser_regex.trim();
    if parser.eq_ignore_ascii_case("toledo:ti200") || parser.to_ascii_lowercase().starts_with("toledo:ti200:p05:") {
        return parse_toledo_ti200_frame(frame, parser);
    }

    let regex = Regex::new(parser_regex).map_err(|err| format!("Regex invalido: {err}"))?;
    let captures = regex
        .captures(frame)
        .ok_or_else(|| "Frame nao contem peso no formato esperado.".to_string())?;
    let raw = captures
        .name("weight")
        .or_else(|| captures.get(1))
        .ok_or_else(|| {
            "Regex precisa capturar o peso no grupo 1 ou no grupo nomeado weight.".to_string()
        })?
        .as_str();
    raw.replace(',', ".")
        .trim()
        .parse::<f64>()
        .map_err(|err| format!("Peso invalido '{raw}': {err}"))
}

fn parse_toledo_ti200_frame(frame: &str, parser: &str) -> Result<f64, String> {
    let frame = strip_control_chars(frame);
    let upper = frame.to_ascii_uppercase();
    if upper.contains("IIIII") || upper.contains("III,III") || upper.contains("III.III") {
        return Err("TI200 indicou peso instavel.".to_string());
    }
    if upper.contains("SSSSS") || upper.contains("SSS,SSS") || upper.contains("SSS.SSS") {
        return Err("TI200 indicou sobrecarga.".to_string());
    }
    if upper.contains("CCCCC") || upper.contains("CCC,CCC") || upper.contains("CCC.CCC") {
        return Err("TI200 ainda esta capturando zero inicial.".to_string());
    }
    if upper.contains("NNNNN") {
        return Err("TI200 indicou peso negativo no protocolo P05A.".to_string());
    }

    let parser_lower = parser.to_ascii_lowercase();
    let status_decimals = parser_lower
        .strip_prefix("toledo:ti200:status:")
        .and_then(|v| v.parse::<i32>().ok());

    for pattern in [
        r"(?P<weight>[-+]\d{1,6}[\.,]\d{1,6})",
        r"(?P<weight>[-+]\d{1,7})",
        r"(?P<weight>\d{1,7}[\.,]\d{1,6})\s*(?:KG|LB)?",
        r"[-+]\w\s+(?P<weight>\d{6})",
    ] {
        let regex = Regex::new(pattern).map_err(|err| format!("Regex TI200 invalido: {err}"))?;
        if let Some(captures) = regex.captures(&frame) {
            let raw = captures
                .name("weight")
                .ok_or_else(|| "Parser TI200 nao encontrou peso.".to_string())?
                .as_str();
            let value = raw
                .replace(',', ".")
                .trim_start_matches('+')
                .parse::<f64>()
                .map_err(|err| format!("Peso TI200 invalido '{raw}': {err}"))?;
            
            if pattern == r"[-+]\w\s+(?P<weight>\d{6})" {
                let decimals = status_decimals.unwrap_or(1);
                return Ok(value / 10_f64.powi(decimals));
            }
            
            return Ok(value);
        }
    }

    let p05_regex = Regex::new(r"(?P<weight>\d{5,7})").map_err(|err| format!("Regex TI200 invalido: {err}"))?;
    if let Some(captures) = p05_regex.captures(&frame) {
        let raw = captures
            .name("weight")
            .ok_or_else(|| "Parser TI200 nao encontrou peso.".to_string())?
            .as_str();
        if let Some(decimals) = parser
            .to_ascii_lowercase()
            .strip_prefix("toledo:ti200:p05:")
            .and_then(|value| value.parse::<i32>().ok())
        {
            let value = raw
                .parse::<f64>()
                .map_err(|err| format!("Peso TI200 P05 invalido '{raw}': {err}"))?;
            return Ok(value / 10_f64.powi(decimals));
        }
        return Err(format!(
            "TI200 respondeu P05/P05A sem separador decimal ({raw}). Configure o indicador em C14=P07/P06 ou use parserRegex toledo:ti200:p05:N, onde N e o numero de casas decimais. Ex.: toledo:ti200:p05:2 para {raw} = {:.2} kg.",
            raw.parse::<f64>().unwrap_or(0.0) / 100.0
        ));
    }

    Err("Frame TI200 nao contem peso reconhecido.".to_string())
}

fn strip_control_chars(frame: &str) -> String {
    frame
        .chars()
        .filter(|ch| !ch.is_control() || *ch == '\t')
        .collect()
}

fn decode_frame_bytes(bytes: &[u8], parser_regex: &str) -> String {
    if parser_regex.trim().to_ascii_lowercase().starts_with("toledo:ti200") {
        return bytes.iter().map(|byte| char::from(byte & 0x7f)).collect();
    }
    String::from_utf8_lossy(bytes).to_string()
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialCandidate {
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParserCandidate {
    pub label: String,
    pub regex: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoConfigureAttempt {
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub command: String,
    pub parser_regex: String,
    pub got_data: bool,
    pub weight_kg: Option<f64>,
    pub reason: Option<String>,
    pub frame: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoConfigureResult {
    pub ok: bool,
    pub message: String,
    pub config: Option<ScaleConfig>,
    pub weight_kg: Option<f64>,
    pub frame: Option<String>,
    pub parser_label: Option<String>,
    pub parser_regex: Option<String>,
    pub attempts: Vec<AutoConfigureAttempt>,
    pub likely_causes: Vec<String>,
    pub tried_ports: Vec<String>,
}

pub fn serial_candidates() -> Vec<SerialCandidate> {
    let mut out: Vec<SerialCandidate> = Vec::new();
    let primary_bauds = [9600_u32, 4800, 19200, 2400, 1200, 38400];
    for baud in primary_bauds {
        out.push(SerialCandidate {
            baud_rate: baud,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".to_string(),
        });
    }
    for baud in [9600_u32, 4800, 19200] {
        for parity in ["even", "odd"] {
            out.push(SerialCandidate {
                baud_rate: baud,
                data_bits: 7,
                stop_bits: 1,
                parity: parity.to_string(),
            });
        }
    }
    out
}

pub fn command_candidates(current: Option<&str>) -> Vec<String> {
    let mut base: Vec<Option<String>> = vec![
        None,
        Some("ENQ".to_string()),
        Some("hex:05".to_string()),
        Some("hex:05 0D".to_string()),
        Some("SI".to_string()),
        Some("ctrl:SI".to_string()),
        Some("hex:0F".to_string()),
        Some("hex:0F 0D".to_string()),
        Some("SO".to_string()),
        Some("ctrl:SO".to_string()),
        Some("P".to_string()),
        Some("W".to_string()),
        Some("S".to_string()),
    ];
    if let Some(cmd) = current {
        let trimmed = cmd.trim().to_string();
        if !trimmed.is_empty() {
            base.insert(0, Some(trimmed));
        }
    }
    let mut out: Vec<String> = base.into_iter().filter_map(|c| c).collect();
    out.push(String::new());
    out.dedup();
    out
}

pub fn parser_candidates() -> Vec<ParserCandidate> {
    vec![
        ParserCandidate { label: "Toledo TI200/Prix (Protocol G)".to_string(), regex: "toledo:ti200".to_string() },
        ParserCandidate { label: "Toledo TI200 P05 2 casas".to_string(), regex: "toledo:ti200:p05:2".to_string() },
        ParserCandidate { label: "Toledo TI200 P05 3 casas".to_string(), regex: "toledo:ti200:p05:3".to_string() },
        ParserCandidate { label: "Toledo 9091 (Protocol G)".to_string(), regex: "toledo:ti200:p05:3".to_string() },
        ParserCandidate { label: "Generico kg".to_string(), regex: r"([-+]?\d+[\.,]?\d*)\s*kg?".to_string() },
        ParserCandidate { label: "Numero com sinal".to_string(), regex: r"[-+]?\d{1,6}[\.,]\d{1,6}".to_string() },
    ]
}

#[derive(Debug, Clone)]
pub struct AttemptScore {
    pub accepted: bool,
    pub weight_kg: Option<f64>,
    pub reason: Option<String>,
}

pub fn score_attempt(frame: &str, parser_regex: &str, expected: Option<f64>) -> AttemptScore {
    if frame.is_empty() {
        return AttemptScore { accepted: false, weight_kg: None, reason: Some("sem dados".to_string()) };
    }
    let upper = frame.to_ascii_uppercase();
    if upper.contains("IIIII") || upper.contains("III,III") || upper.contains("III.III") {
        return AttemptScore { accepted: false, weight_kg: None, reason: Some("instavel".to_string()) };
    }
    if upper.contains("SSSSS") || upper.contains("SSS,SSS") || upper.contains("SSS.SSS") {
        return AttemptScore { accepted: false, weight_kg: None, reason: Some("sobrecarga".to_string()) };
    }
    if upper.contains("CCCCC") || upper.contains("CCC,CCC") || upper.contains("CCC.CCC") {
        return AttemptScore { accepted: false, weight_kg: None, reason: Some("capturando zero".to_string()) };
    }
    if upper.contains("NNNNN") {
        return AttemptScore { accepted: false, weight_kg: None, reason: Some("peso negativo".to_string()) };
    }
    match parse_weight_frame(frame, parser_regex) {
        Ok(weight) => {
            if let Some(prev) = expected {
                if (weight - prev).abs() > 1.0 {
                    return AttemptScore { accepted: false, weight_kg: Some(weight), reason: Some("leitura muito diferente da previa".to_string()) };
                }
            }
            AttemptScore { accepted: true, weight_kg: Some(weight), reason: None }
        }
        Err(err) => AttemptScore { accepted: false, weight_kg: None, reason: Some(err) },
    }
}

pub fn build_candidate_config(
    base: &ScaleConfig,
    serial: &SerialCandidate,
    command: Option<&str>,
    parser_regex: &str,
) -> ScaleConfig {
    let mut next = base.clone();
    next.baud_rate = serial.baud_rate;
    next.data_bits = serial.data_bits;
    next.stop_bits = serial.stop_bits;
    next.parity = serial.parity.clone();
    next.read_command = command.filter(|c| !c.is_empty()).map(str::to_string);
    next.parser_regex = parser_regex.to_string();
    next
}

pub fn likely_causes_for_no_data() -> Vec<String> {
    vec![
        "Outro sistema pode estar usando esta porta serial no momento.".to_string(),
        "Porta COM incorreta ou conversor USB-Serial diferente do esperado.".to_string(),
        "Cabo RS232 com TX/RX invertido ou sem sinal de DTR/RTS.".to_string(),
        "Saida serial da balanca desabilitada ou configurada para outro modo.".to_string(),
        "Protocolo/comando fora da lista testada (consulte o manual do fabricante).".to_string(),
    ]
}

fn read_scale_raw_with_serial(base: &ScaleConfig, serial: &SerialCandidate) -> Result<String, String> {
    let mut next = base.clone();
    next.baud_rate = serial.baud_rate;
    next.data_bits = serial.data_bits;
    next.stop_bits = serial.stop_bits;
    next.parity = serial.parity.clone();
    read_scale_raw(next)
}

fn read_scale_once_with_serial(base: &ScaleConfig, serial: &SerialCandidate, command: Option<&str>, parser_regex: &str) -> Result<f64, String> {
    let next = build_candidate_config(base, serial, command, parser_regex);
    read_scale_once(next)
}

#[tauri::command]
pub fn auto_configure_scale_serial(
    config: ScaleConfig,
) -> Result<AutoConfigureResult, String> {
    if config.mode.as_deref() == Some("tcp") {
        return Err("Auto-configuracao exige balanca em modo Serial real.".to_string());
    }
    if config.mode.as_deref() == Some("simulated") {
        return Err("Auto-configuracao nao se aplica a balanca simulada.".to_string());
    }
    if config.port.trim().is_empty() {
        return Err("Selecione uma porta serial antes de iniciar a auto-configuracao.".to_string());
    }

    let mut attempts: Vec<AutoConfigureAttempt> = Vec::new();
    let mut last_weight: Option<f64> = None;
    let mut first_success: Option<(SerialCandidate, String, ParserCandidate, f64, String)> = None;

    let serials = serial_candidates();
    let commands = command_candidates(config.read_command.as_deref());
    let parsers = parser_candidates();

    for serial in &serials {
        for cmd in &commands {
            let frame_result = read_scale_raw_with_serial(&config, serial);
            let frame = match &frame_result {
                Ok(text) => text.clone(),
                Err(err) => {
                    attempts.push(AutoConfigureAttempt {
                        baud_rate: serial.baud_rate,
                        data_bits: serial.data_bits,
                        stop_bits: serial.stop_bits,
                        parity: serial.parity.clone(),
                        command: cmd.clone(),
                        parser_regex: String::new(),
                        got_data: false,
                        weight_kg: None,
                        reason: Some("erro serial".to_string()),
                        frame: String::new(),
                        error: Some(err.clone()),
                    });
                    continue;
                }
            };
            let got_data = !frame.starts_with("Nenhum dado recebido");
            if !got_data {
                attempts.push(AutoConfigureAttempt {
                    baud_rate: serial.baud_rate,
                    data_bits: serial.data_bits,
                    stop_bits: serial.stop_bits,
                    parity: serial.parity.clone(),
                    command: cmd.clone(),
                    parser_regex: String::new(),
                    got_data: false,
                    weight_kg: None,
                    reason: Some("timeout".to_string()),
                    frame,
                    error: None,
                });
                continue;
            }
            for parser in &parsers {
                let score = score_attempt(&frame, &parser.regex, last_weight);
                attempts.push(AutoConfigureAttempt {
                    baud_rate: serial.baud_rate,
                    data_bits: serial.data_bits,
                    stop_bits: serial.stop_bits,
                    parity: serial.parity.clone(),
                    command: cmd.clone(),
                    parser_regex: parser.regex.clone(),
                    got_data: true,
                    weight_kg: score.weight_kg,
                    reason: score.reason.clone(),
                    frame: frame.clone(),
                    error: None,
                });
                if score.accepted {
                    if let Some(weight) = score.weight_kg {
                        if first_success.is_none() {
                            first_success = Some((serial.clone(), cmd.clone(), parser.clone(), weight, frame.clone()));
                            last_weight = Some(weight);
                            break;
                        }
                    }
                }
            }
            if first_success.is_some() {
                break;
            }
        }
        if first_success.is_some() {
            break;
        }
    }

    if let Some((serial, cmd, parser, weight, frame)) = first_success {
        let mut confirmed_weight = weight;
        let mut stable_readings = 1_u32;
        for _ in 0..1 {
            match read_scale_once_with_serial(&config, &serial, Some(&cmd), &parser.regex) {
                Ok(next) => {
                    if (next - confirmed_weight).abs() <= 0.5 {
                        stable_readings += 1;
                        confirmed_weight = next;
                    } else {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let final_config = build_candidate_config(&config, &serial, Some(&cmd), &parser.regex);
        return Ok(AutoConfigureResult {
            ok: true,
            message: format!(
                "Balanca configurada em {} {} {}{}1 com comando {} e parser {} ({} leituras estaveis).",
                serial.baud_rate,
                serial.data_bits,
                serial.parity.chars().next().map(|c| c.to_ascii_uppercase().to_string()).unwrap_or_else(|| "N".to_string()),
                serial.stop_bits,
                if cmd.is_empty() { "<sem comando>".to_string() } else { cmd.clone() },
                parser.label,
                stable_readings
            ),
            config: Some(final_config),
            weight_kg: Some(confirmed_weight),
            frame: Some(frame),
            parser_label: Some(parser.label),
            parser_regex: Some(parser.regex),
            attempts,
            likely_causes: Vec::new(),
            tried_ports: vec![config.port.clone()],
        });
    }

    Ok(AutoConfigureResult {
        ok: false,
        message: "Nenhuma combinacao recebeu dados da balanca.".to_string(),
        config: None,
        weight_kg: None,
        frame: None,
        parser_label: None,
        parser_regex: None,
        attempts,
        likely_causes: likely_causes_for_no_data(),
        tried_ports: vec![config.port.clone()],
    })
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
        let host = config
            .host
            .as_ref()
            .filter(|h| !h.is_empty())
            .ok_or("Host TCP da balanca nao configurado.".to_string())?;
        let port = if config.port.is_empty() {
            "4001".to_string()
        } else {
            config.port.clone()
        };
        let port_num = port
            .parse::<u16>()
            .map_err(|_| format!("Porta TCP invalida: {port}"))?;

        let mut stream = TcpStream::connect((host.as_str(), port_num))
            .map_err(|err| format!("Falha ao conectar na balanca TCP {host}:{port_num}: {err}"))?;
        stream
            .set_read_timeout(Some(Duration::from_millis(1500)))
            .map_err(|err| err.to_string())?;

        if let Some(command) = config
            .read_command
            .as_ref()
            .filter(|value| !value.is_empty())
        {
            stream
                .write_all(&command_bytes(command))
                .map_err(|err| err.to_string())?;
            stream.flush().map_err(|err| err.to_string())?;
            std::thread::sleep(Duration::from_millis(250));
        }

        let mut buffer = vec![0_u8; 256];
        let read = stream
            .read(buffer.as_mut_slice())
            .map_err(|err| err.to_string())?;
        let frame = decode_frame_bytes(&buffer[..read], &config.parser_regex);
        return parse_weight_frame(&frame, &config.parser_regex);
    }

    if config.port.trim().is_empty() {
        return Err("Porta serial da balanca nao configurada.".to_string());
    }

    let mut builder =
        serialport::new(config.port.clone(), config.baud_rate).timeout(Duration::from_millis(1500));
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
    prepare_serial_port(port.as_mut())?;
    if let Some(command) = config
        .read_command
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        port.write_all(&command_bytes(command))
            .map_err(|err| err.to_string())?;
        port.flush().map_err(|err| err.to_string())?;
        std::thread::sleep(Duration::from_millis(250));
    }
    let mut buffer = vec![0_u8; 256];
    let read = port
        .read(buffer.as_mut_slice())
        .map_err(|err| err.to_string())?;
    let frame = decode_frame_bytes(&buffer[..read], &config.parser_regex);
    parse_weight_frame(&frame, &config.parser_regex)
}

#[tauri::command]
pub fn read_scale_raw(config: ScaleConfig) -> Result<String, String> {
    if config.mode.as_deref() == Some("simulated") {
        return Ok(format!(
            "SIMULATED: {} kg",
            config.simulated_weight_kg.unwrap_or(12.345)
        ));
    }

    if config.mode.as_deref() == Some("tcp") {
        let host = config
            .host
            .as_ref()
            .filter(|h| !h.is_empty())
            .ok_or("Host TCP da balanca nao configurado.".to_string())?;
        let port = if config.port.is_empty() {
            "4001".to_string()
        } else {
            config.port.clone()
        };
        let port_num = port
            .parse::<u16>()
            .map_err(|_| format!("Porta TCP invalida: {port}"))?;

        let mut stream = TcpStream::connect((host.as_str(), port_num))
            .map_err(|err| format!("Falha ao conectar na balanca TCP {host}:{port_num}: {err}"))?;
        stream
            .set_read_timeout(Some(Duration::from_millis(300)))
            .map_err(|err| err.to_string())?;

        if let Some(command) = config
            .read_command
            .as_ref()
            .filter(|value| !value.is_empty())
        {
            stream
                .write_all(&command_bytes(command))
                .map_err(|err| err.to_string())?;
            stream.flush().map_err(|err| err.to_string())?;
            std::thread::sleep(Duration::from_millis(250));
        }

        let bytes = collect_raw_bytes(&mut stream, Duration::from_millis(3500))?;
        return Ok(format_raw_bytes(&bytes));
    }

    if config.port.trim().is_empty() {
        return Err("Porta serial da balanca nao configurada.".to_string());
    }

    let mut builder =
        serialport::new(config.port.clone(), config.baud_rate).timeout(Duration::from_millis(300));
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
    prepare_serial_port(port.as_mut())?;
    if let Some(command) = config
        .read_command
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        port.write_all(&command_bytes(command))
            .map_err(|err| err.to_string())?;
        port.flush().map_err(|err| err.to_string())?;
        std::thread::sleep(Duration::from_millis(250));
    }
    let bytes = collect_raw_bytes(&mut port, Duration::from_millis(3500))?;
    Ok(format_raw_bytes(&bytes))
}

fn collect_raw_bytes<R: Read>(reader: &mut R, window: Duration) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + window;
    let mut output = Vec::new();
    while Instant::now() < deadline {
        let mut buffer = [0_u8; 512];
        match reader.read(&mut buffer) {
            Ok(0) => {
                if !output.is_empty() {
                    break;
                }
            }
            Ok(read) => {
                output.extend_from_slice(&buffer[..read]);
                if output.len() >= 512 {
                    break;
                }
            }
            Err(err)
                if err.kind() == std::io::ErrorKind::TimedOut
                    || err.kind() == std::io::ErrorKind::WouldBlock =>
            {
                if !output.is_empty() {
                    break;
                }
            }
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(output)
}

fn command_bytes(command: &str) -> Vec<u8> {
    let trimmed = command.trim();
    if let Some(hex) = trimmed.strip_prefix("hex:") {
        let bytes = hex
            .split(|value: char| {
                value.is_whitespace() || value == ',' || value == ';' || value == '-'
            })
            .filter(|value| !value.is_empty())
            .filter_map(|value| u8::from_str_radix(value.trim_start_matches("0x"), 16).ok())
            .collect::<Vec<_>>();
        if !bytes.is_empty() {
            return bytes;
        }
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "ctrl:enq" | "enq" => return vec![0x05],
        "ctrl:si" => return vec![0x0f],
        "ctrl:so" => return vec![0x0e],
        "ctrl:stx" => return vec![0x02],
        "ctrl:etx" => return vec![0x03],
        _ => {}
    }
    if command.ends_with('\n') {
        command.as_bytes().to_vec()
    } else {
        format!("{}\r\n", command).into_bytes()
    }
}

fn prepare_serial_port(port: &mut dyn SerialPort) -> Result<(), String> {
    // Many RS-232 indicators require DTR/RTS asserted even when Windows shows flow control as "None".
    let _ = port.clear(serialport::ClearBuffer::All);
    let _ = port.write_data_terminal_ready(true);
    let _ = port.write_request_to_send(true);
    std::thread::sleep(Duration::from_millis(250));
    Ok(())
}

fn format_raw_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "Nenhum dado recebido em 3,5s. Se esta balanca funciona em outro sistema, ela provavelmente precisa de outro comando de leitura ou o outro sistema deixa a transmissao continua ativada.".to_string();
    }
    let text = String::from_utf8_lossy(bytes)
        .replace('\r', "\\r")
        .replace('\n', "\\n");
    let ascii_7bit = bytes
        .iter()
        .map(|byte| char::from(byte & 0x7f))
        .collect::<String>()
        .replace('\u{02}', "<STX>")
        .replace('\u{03}', "<ETX>")
        .replace('\r', "\\r")
        .replace('\n', "\\n");
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("Texto: {text}\nASCII 7-bit: {ascii_7bit}\nHex: {hex}\nBytes: {}", bytes.len())
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
    let mut scales = if config.scales.is_empty() {
        vec![config.scale.clone()]
    } else {
        config.scales.clone()
    };
    if !scales.iter().any(|scale| scale.port == config.scale.port) {
        scales.insert(0, config.scale.clone());
    }
    scales
}

pub fn configured_printers(config: &StationConfig) -> Vec<crate::config::PrinterConfig> {
    let mut printers = if config.printers.is_empty() {
        vec![config.printer.clone()]
    } else {
        config.printers.clone()
    };
    if !printers
        .iter()
        .any(|printer| printer.local_id == config.printer.local_id)
    {
        printers.insert(0, config.printer.clone());
    }
    printers
}

#[tauri::command]
pub async fn enroll_agent(
    server_url: String,
    code: String,
    station_label: String,
) -> Result<EnrollmentResult, String> {
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
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.as_str())
                    .map(str::to_string)
            })
            .unwrap_or(body);
        return Err(message);
    }
    serde_json::from_str(&body).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn heartbeat_once(config: StationConfig) -> Result<serde_json::Value, String> {
    let token = config
        .token
        .clone()
        .ok_or_else(|| "Agente ainda nao matriculado.".to_string())?;
    save_config(config.clone())?;
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/hardware/agent/heartbeat",
        config.server_url.trim_end_matches('/')
    );
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
    let token = config
        .token
        .clone()
        .ok_or_else(|| "Agente ainda nao matriculado.".to_string())?;
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/hardware/agent/realtime-token",
        config.server_url.trim_end_matches('/')
    );
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
pub async fn submit_capture(
    config: StationConfig,
    request: CaptureRequest,
) -> Result<serde_json::Value, String> {
    let token = config
        .token
        .clone()
        .ok_or_else(|| "Agente ainda nao matriculado.".to_string())?;
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/hardware/agent/captures",
        config.server_url.trim_end_matches('/')
    );
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
pub async fn report_print_job(
    config: StationConfig,
    request: PrintJobStatusRequest,
) -> Result<serde_json::Value, String> {
    let token = config
        .token
        .clone()
        .ok_or_else(|| "Agente ainda nao matriculado.".to_string())?;
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
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.as_str())
                    .map(str::to_string)
            })
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
    fn parses_toledo_ti200_p07_frame() {
        let weight = parse_weight_frame("\u{02}+012,345\u{03}", "toledo:ti200").unwrap();
        assert!((weight - 12.345).abs() < 0.0001);
    }

    #[test]
    fn decodes_toledo_ti200_7bit_parity_frame() {
        let frame = decode_frame_bytes(&[0x02, 0xb0, 0xb0, 0x31, 0x31, 0x34, 0x83], "toledo:ti200");
        assert_eq!(frame, "\u{02}00114\u{03}");
    }

    #[test]
    fn toledo_ti200_requires_decimals_for_p05_frame() {
        let error = parse_weight_frame("\u{02}00114\u{03}", "toledo:ti200").unwrap_err();
        assert!(error.contains("P05/P05A"));
    }

    #[test]
    fn parses_toledo_ti200_p05_with_configured_decimals() {
        let weight = parse_weight_frame("\u{02}00114\u{03}", "toledo:ti200:p05:2").unwrap();
        assert!((weight - 1.14).abs() < 0.0001);
    }

    #[test]
    fn parses_toledo_ti200_status_and_12_digit_frame() {
        let weight = parse_weight_frame("+q 000238000001", "toledo:ti200").unwrap();
        assert!((weight - 23.8).abs() < 0.0001);
    }

    #[test]
    fn toledo_ti200_reports_unstable_frame() {
        let error = parse_weight_frame("\u{02}+III,III\u{03}", "toledo:ti200").unwrap_err();
        assert!(error.contains("instavel"));
    }

    #[test]
    fn encodes_toledo_enq_command() {
        assert_eq!(command_bytes("ENQ"), vec![0x05]);
        assert_eq!(command_bytes("hex:05"), vec![0x05]);
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

    #[test]
    fn serial_candidates_include_8n1_at_9600_and_7e1() {
        let candidates = serial_candidates();
        assert!(candidates.iter().any(|c| c.baud_rate == 9600 && c.data_bits == 8 && c.stop_bits == 1 && c.parity == "none"));
        assert!(candidates.iter().any(|c| c.data_bits == 7 && c.parity == "even" && c.stop_bits == 1));
        assert!(candidates.iter().any(|c| c.baud_rate == 4800));
        let mut seen = std::collections::HashSet::new();
        for c in &candidates {
            let key = (c.baud_rate, c.data_bits, c.stop_bits, c.parity.clone());
            assert!(seen.insert(key.clone()), "serial_candidates tem duplicado: {:?}", key);
        }
    }

    #[test]
    fn command_candidates_prioritize_current_command() {
        let cmds = command_candidates(Some("P"));
        assert_eq!(cmds.first().map(String::as_str), Some("P"));
        assert!(cmds.contains(&"ENQ".to_string()));
        assert!(cmds.iter().any(|c| c.is_empty()));
    }

    #[test]
    fn command_candidates_dedup_with_current_command() {
        let cmds = command_candidates(Some("ENQ"));
        let count = cmds.iter().filter(|c| c.as_str() == "ENQ").count();
        assert_eq!(count, 1, "ENQ duplicado removido: {:?}", cmds);
    }

    #[test]
    fn parser_candidates_cover_ti200_p07_p05_9091_and_generic() {
        let parsers: Vec<String> = parser_candidates().into_iter().map(|p| p.regex).collect();
        assert!(parsers.iter().any(|p| p == "toledo:ti200"));
        assert!(parsers.iter().any(|p| p == "toledo:ti200:p05:2"));
        assert!(parsers.iter().any(|p| p == "toledo:ti200:p05:3"));
        assert!(parsers.iter().any(|p| p == r"([-+]?\d+[\.,]?\d*)\s*kg?"));
    }

    #[test]
    fn score_attempt_rejects_unstable_and_empty_frames() {
        let unstable = score_attempt("\u{02}+III,III\u{03}", "toledo:ti200", None);
        assert_eq!(unstable.reason.as_deref(), Some("instavel"));
        assert!(!unstable.accepted);
        let empty = score_attempt("", "toledo:ti200", None);
        assert!(!empty.accepted);
    }

    #[test]
    fn score_attempt_accepts_ti200_p07_with_consistent_readings() {
        let s1 = score_attempt("\u{02}+012,345\u{03}", "toledo:ti200", Some(12.345));
        assert!(s1.accepted, "score_attempt deveria aceitar frame TI200 P07: {:?}", s1);
        assert_eq!(s1.weight_kg, Some(12.345));
    }

    #[test]
    fn score_attempt_accepts_p05_with_configured_decimals() {
        let s = score_attempt("\u{02}00114\u{03}", "toledo:ti200:p05:2", None);
        assert!(s.accepted, "P05 com decimais deveria passar: {:?}", s);
        assert!((s.weight_kg.unwrap() - 1.14).abs() < 0.0001);
    }

    #[test]
    fn score_attempt_accepts_status_12_digit_frame() {
        let s = score_attempt("+q 000238000001", "toledo:ti200", None);
        assert!(s.accepted);
        assert!((s.weight_kg.unwrap() - 23.8).abs() < 0.0001);
    }

    #[test]
    fn score_attempt_accepts_generic_kg_frame() {
        let s = score_attempt("ST,GS,+0012.345kg", r"([-+]?\d+[\.,]?\d*)\s*kg?", None);
        assert!(s.accepted, "frame kg generico deveria passar: {:?}", s);
        assert!((s.weight_kg.unwrap() - 12.345).abs() < 0.0001);
    }

    #[test]
    fn score_attempt_rejects_frame_with_way_off_reading() {
        let s = score_attempt("\u{02}+012,345\u{03}", "toledo:ti200", Some(99.999));
        assert!(!s.accepted, "leitura muito diferente da previa nao pode ser aceita: {:?}", s);
    }

    #[test]
    fn score_attempt_handles_status_and_plain_12_digit() {
        let plain = score_attempt("+000238000001", "toledo:ti200", None);
        let status = score_attempt("+q 000238000001", "toledo:ti200", None);
        assert!(plain.accepted);
        assert!(status.accepted);
        assert!((status.weight_kg.unwrap() - 23.8).abs() < 0.0001);
        assert!((plain.weight_kg.unwrap() - 2380.0).abs() < 0.0001);
    }

    #[test]
    fn build_candidate_config_overrides_serial_and_command() {
        let base = ScaleConfig {
            mode: Some("serial".to_string()),
            port: "COM12".to_string(),
            host: None,
            simulated_weight_kg: None,
            baud_rate: 9600,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".to_string(),
            read_command: None,
            parser_regex: "toledo:ti200".to_string(),
            stable_window: 4,
            stable_threshold_kg: 0.02,
            stable_ms: 1200,
            min_weight_kg: 1.0,
            cooldown_ms: 1500,
            zero_threshold_kg: 0.25,
        };
        let next = build_candidate_config(&base, &SerialCandidate { baud_rate: 4800, data_bits: 7, stop_bits: 1, parity: "even".to_string() }, Some("ENQ"), "toledo:ti200:p05:2");
        assert_eq!(next.baud_rate, 4800);
        assert_eq!(next.data_bits, 7);
        assert_eq!(next.stop_bits, 1);
        assert_eq!(next.parity, "even");
        assert_eq!(next.read_command.as_deref(), Some("ENQ"));
        assert_eq!(next.parser_regex, "toledo:ti200:p05:2");
        assert_eq!(next.port, "COM12");
    }

    #[test]
    fn likley_causes_for_no_data_lists_commonly_known_reasons() {
        let causes = likely_causes_for_no_data();
        assert!(causes.iter().any(|c| c.contains("COM")));
        assert!(causes.iter().any(|c| c.to_lowercase().contains("outro sistema")));
        assert!(causes.iter().any(|c| c.to_lowercase().contains("cabo")));
    }
}
