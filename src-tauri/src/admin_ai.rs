use crate::config::{load_config, save_config, StationConfig};
use crate::hardware::{list_serial_ports, read_scale_once, read_scale_raw, test_scale_parse};
use crate::printing::{list_printers, test_print_zpl};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const ADMIN_SALT: &str = "printerfrigo-admin-v1";
const ADMIN_PASSWORD_HASH: &str = "6929d63bd54615f546a7fb869707784d88e21be5990a45558bbc80eb471e7455";
const MAX_ATTEMPTS: u8 = 5;
const LOCKOUT_MS: u64 = 60_000;
const SESSION_MS: u64 = 15 * 60_000;

#[derive(Default)]
pub struct AdminState {
    inner: Mutex<AdminStateInner>,
}

#[derive(Default)]
struct AdminStateInner {
    failed_attempts: u8,
    locked_until_ms: u64,
    session_token: Option<String>,
    session_expires_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSession {
    token: String,
    expires_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminStatus {
    authenticated: bool,
    expires_at_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocalSnapshot {
    saved_config: Option<StationConfig>,
    draft_config: Option<StationConfig>,
    serial_ports: Value,
    printers: Value,
    print_jobs: Value,
    services: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolRequest {
    tool: String,
    args: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolResult {
    ok: bool,
    message: String,
    data: Value,
}

#[tauri::command]
pub fn admin_login(password: String, state: tauri::State<AdminState>) -> Result<AdminSession, String> {
    let mut guard = state.inner.lock().map_err(|_| "Estado admin indisponivel.".to_string())?;
    let now = now_ms();
    if guard.locked_until_ms > now {
        let remaining = ((guard.locked_until_ms - now) / 1000).max(1);
        return Err(format!("Muitas tentativas. Tente novamente em {remaining}s."));
    }

    if hash_password(&password) != ADMIN_PASSWORD_HASH {
        guard.failed_attempts = guard.failed_attempts.saturating_add(1);
        if guard.failed_attempts >= MAX_ATTEMPTS {
            guard.locked_until_ms = now + LOCKOUT_MS;
            guard.failed_attempts = 0;
        }
        return Err("Senha admin invalida.".to_string());
    }

    let token = Uuid::new_v4().to_string();
    let expires_at_ms = now + SESSION_MS;
    guard.failed_attempts = 0;
    guard.locked_until_ms = 0;
    guard.session_token = Some(token.clone());
    guard.session_expires_at_ms = expires_at_ms;
    Ok(AdminSession { token, expires_at_ms })
}

#[tauri::command]
pub fn admin_logout(token: String, state: tauri::State<AdminState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|_| "Estado admin indisponivel.".to_string())?;
    if guard.session_token.as_deref() == Some(token.as_str()) {
        guard.session_token = None;
        guard.session_expires_at_ms = 0;
    }
    Ok(())
}

#[tauri::command]
pub fn admin_status(token: Option<String>, state: tauri::State<AdminState>) -> Result<AdminStatus, String> {
    let guard = state.inner.lock().map_err(|_| "Estado admin indisponivel.".to_string())?;
    let authenticated = is_session_valid(&guard, token.as_deref());
    Ok(AdminStatus {
        authenticated,
        expires_at_ms: authenticated.then_some(guard.session_expires_at_ms),
    })
}

#[tauri::command]
pub fn ensure_windows_autostart() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let command = format!("\"{}\" --minimized", exe.display());
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run, _) = hkcu
            .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
            .map_err(|err| err.to_string())?;
        run.set_value("PRINTERFRIGO", &command).map_err(|err| err.to_string())?;
        Ok("Inicializacao com Windows ativada.".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    Ok("Autostart e aplicado apenas no Windows.".to_string())
}

#[tauri::command]
pub fn ai_collect_snapshot(
    token: String,
    draft_config: Option<StationConfig>,
    state: tauri::State<AdminState>,
) -> Result<AiLocalSnapshot, String> {
    require_admin(&token, &state)?;
    Ok(AiLocalSnapshot {
        saved_config: load_config().unwrap_or(None),
        draft_config,
        serial_ports: to_json(list_serial_ports()),
        printers: to_json(list_printers()),
        print_jobs: powershell_json("Get-Printer | ForEach-Object { $p=$_.Name; [pscustomobject]@{ printer=$p; jobs=@(Get-PrintJob -PrinterName $p -ErrorAction SilentlyContinue | Select-Object ID,JobStatus,SubmittedTime,Size) } } | ConvertTo-Json -Depth 5"),
        services: powershell_json("Get-Service Spooler | Select-Object Name,DisplayName,Status | ConvertTo-Json -Depth 3"),
    })
}

#[tauri::command]
pub fn ai_save_station_config(
    token: String,
    config: StationConfig,
    state: tauri::State<AdminState>,
) -> Result<(), String> {
    require_admin(&token, &state)?;
    save_config(config)
}

#[tauri::command]
pub fn ai_run_local_tool(
    token: String,
    request: LocalToolRequest,
    state: tauri::State<AdminState>,
) -> Result<LocalToolResult, String> {
    require_admin(&token, &state)?;
    match request.tool.as_str() {
        "restart_print_spooler" => restart_print_spooler(),
        "clear_print_queue" => clear_print_queue(required_string(&request.args, "queueName")?),
        "test_tcp_9100" => test_tcp_connection(
            required_string(&request.args, "host")?,
            optional_u16(&request.args, "port").unwrap_or(9100),
        ),
        "test_print_zpl" => {
            let config: crate::config::PrinterConfig = serde_json::from_value(
                request.args.get("printer").cloned().ok_or_else(|| "Campo printer ausente.".to_string())?,
            )
            .map_err(|err| err.to_string())?;
            let zpl = request
                .args
                .get("zpl")
                .and_then(Value::as_str)
                .unwrap_or("^XA^FO40,40^A0N,36,36^FDPRINTERFRIGO AI TEST^FS^XZ")
                .to_string();
            test_print_zpl(config, zpl).map(|message| ok(message, json!({})))
        }
        "read_scale_once" => {
            let config: crate::config::ScaleConfig = serde_json::from_value(
                request.args.get("scale").cloned().ok_or_else(|| "Campo scale ausente.".to_string())?,
            )
            .map_err(|err| err.to_string())?;
            read_scale_once(config).map(|weight| ok("Leitura de balanca concluida.".to_string(), json!({ "weightKg": weight })))
        }
        "read_scale_raw" => {
            let config: crate::config::ScaleConfig = serde_json::from_value(
                request.args.get("scale").cloned().ok_or_else(|| "Campo scale ausente.".to_string())?,
            )
            .map_err(|err| err.to_string())?;
            read_scale_raw(config).map(|frame| ok("Frame bruto da balanca lido.".to_string(), json!({ "frame": frame })))
        }
        "diagnose_scale_serial" => {
            let config: crate::config::ScaleConfig = serde_json::from_value(
                request.args.get("scale").cloned().ok_or_else(|| "Campo scale ausente.".to_string())?,
            )
            .map_err(|err| err.to_string())?;
            diagnose_scale_serial(config)
        }
        "test_scale_parse" => {
            let frame = required_string(&request.args, "frame")?;
            let parser_regex = required_string(&request.args, "parserRegex")?;
            test_scale_parse(frame, parser_regex)
                .map(|weight| ok("Parser de balanca validado.".to_string(), json!({ "weightKg": weight })))
        }
        "refresh_devices" => Ok(ok(
            "Dispositivos atualizados.".to_string(),
            json!({
                "serialPorts": to_json(list_serial_ports()),
                "printers": to_json(list_printers())
            }),
        )),
        other => Err(format!("Ferramenta local nao permitida: {other}")),
    }
}

fn hash_password(password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{ADMIN_SALT}:{}", password.trim()).as_bytes());
    format!("{:x}", hasher.finalize())
}

fn require_admin(token: &str, state: &tauri::State<AdminState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "Estado admin indisponivel.".to_string())?;
    if is_session_valid(&guard, Some(token)) {
        Ok(())
    } else {
        Err("Sessao admin expirada ou invalida.".to_string())
    }
}

fn is_session_valid(guard: &AdminStateInner, token: Option<&str>) -> bool {
    token.is_some()
        && guard.session_token.as_deref() == token
        && guard.session_expires_at_ms > now_ms()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn powershell_json(script: &str) -> Value {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("powershell");
        command.creation_flags(CREATE_NO_WINDOW).args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ]);
        let output = command.output();
        match output {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                serde_json::from_str(stdout.trim()).unwrap_or_else(|_| json!({ "raw": stdout.trim() }))
            }
            Ok(output) => json!({ "error": String::from_utf8_lossy(&output.stderr).trim() }),
            Err(err) => json!({ "error": err.to_string() }),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = script;
        json!({ "error": "PowerShell disponivel apenas no Windows." })
    }
}

fn restart_print_spooler() -> Result<LocalToolResult, String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("powershell");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Restart-Service -Name Spooler -Force; Get-Service Spooler | Select-Object Name,Status | ConvertTo-Json",
            ]);
        let output = command.output().map_err(|err| err.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(ok(
            "Spooler de impressao reiniciado.".to_string(),
            serde_json::from_slice(&output.stdout).unwrap_or_else(|_| json!({})),
        ))
    }

    #[cfg(not(target_os = "windows"))]
    Err("Spooler disponivel apenas no Windows.".to_string())
}

fn clear_print_queue(queue_name: String) -> Result<LocalToolResult, String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("powershell");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "param($Queue) Get-PrintJob -PrinterName $Queue -ErrorAction SilentlyContinue | Remove-PrintJob",
                &queue_name,
            ]);
        let output = command.output().map_err(|err| err.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(ok(format!("Fila {queue_name} limpa."), json!({ "queueName": queue_name })))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = queue_name;
        Err("Fila Windows disponivel apenas no Windows.".to_string())
    }
}

fn test_tcp_connection(host: String, port: u16) -> Result<LocalToolResult, String> {
    let addr = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|err| err.to_string())?
        .next()
        .ok_or_else(|| "Host TCP invalido.".to_string())?;
    TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|err| err.to_string())?;
    Ok(ok(format!("Conexao TCP OK em {host}:{port}."), json!({ "host": host, "port": port })))
}

fn diagnose_scale_serial(config: crate::config::ScaleConfig) -> Result<LocalToolResult, String> {
    if config.mode.as_deref() == Some("tcp") {
        return Err("Diagnostico serial exige balanca em modo Serial real.".to_string());
    }
    if config.port.trim().is_empty() {
        return Err("Porta serial ausente para diagnostico.".to_string());
    }

    let mut attempts = Vec::new();
    let mut commands = vec![None, Some("SI"), Some("P"), Some("W"), Some("S")];
    if let Some(command) = config.read_command.as_deref().filter(|value| !value.trim().is_empty()) {
        commands.insert(0, Some(command));
    }

    let mut bauds = vec![config.baud_rate, 9600, 4800, 19200];
    bauds.sort_unstable();
    bauds.dedup();

    for baud in bauds {
        for command in &commands {
            let mut next = config.clone();
            next.baud_rate = baud;
            next.read_command = command.map(str::to_string);
            let label = command.unwrap_or("<sem comando>");
            match read_scale_raw(next) {
                Ok(frame) => {
                    let got_data = !frame.starts_with("Nenhum dado recebido");
                    attempts.push(json!({
                        "baudRate": baud,
                        "command": label,
                        "gotData": got_data,
                        "frame": frame,
                    }));
                    if got_data {
                        return Ok(ok(
                            format!("Balanca respondeu em {baud} baud com comando {label}."),
                            json!({ "attempts": attempts }),
                        ));
                    }
                }
                Err(error) => attempts.push(json!({
                    "baudRate": baud,
                    "command": label,
                    "gotData": false,
                    "error": error,
                })),
            }
        }
    }

    Ok(ok(
        "Diagnostico concluido: nenhuma tentativa recebeu dados da balanca.".to_string(),
        json!({ "attempts": attempts }),
    ))
}

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("Campo obrigatorio ausente: {key}"))
}

fn optional_u16(args: &Value, key: &str) -> Option<u16> {
    args.get(key).and_then(Value::as_u64).and_then(|value| u16::try_from(value).ok())
}

fn to_json<T: Serialize, E: ToString>(result: Result<T, E>) -> Value {
    match result {
        Ok(value) => serde_json::to_value(value).unwrap_or_else(|_| json!(null)),
        Err(err) => json!({ "error": err.to_string() }),
    }
}

fn ok(message: String, data: Value) -> LocalToolResult {
    LocalToolResult { ok: true, message, data }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_password_hash_matches_initial_password() {
        assert_eq!(hash_password("Nescau2.0"), ADMIN_PASSWORD_HASH);
        assert_ne!(hash_password("nescau2.0"), ADMIN_PASSWORD_HASH);
    }

    #[test]
    fn rejects_unknown_tool_names() {
        let request = LocalToolRequest { tool: "powershell".to_string(), args: json!({}) };
        assert_eq!(request.tool, "powershell");
    }
}
