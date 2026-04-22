use crate::config::{app_dir, PrinterConfig};
use chrono::Utc;
use std::fs;
use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;

#[tauri::command]
pub fn list_printers() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-Printer | Sort-Object Name | Select-Object -ExpandProperty Name"])
            .output()
            .map_err(|err| err.to_string())?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Ok(stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToString::to_string)
            .collect());
    }

    #[cfg(not(target_os = "windows"))]
    Ok(Vec::new())
}

#[tauri::command]
pub fn test_print_zpl(printer: PrinterConfig, zpl: String) -> Result<String, String> {
    print_zpl(&printer, &zpl)
}

pub fn print_zpl(printer: &PrinterConfig, zpl: &str) -> Result<String, String> {
    match printer.mode.as_str() {
        "dry_run" => write_dry_run(printer, zpl),
        "tcp_9100" => print_tcp(printer, zpl),
        "windows_spooler" => print_windows_spooler(printer, zpl),
        other => Err(format!("Modo de impressao invalido: {other}")),
    }
}

fn write_dry_run(printer: &PrinterConfig, zpl: &str) -> Result<String, String> {
    let dir = printer
        .dry_run_dir
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(app_dir()?.join("dry-run"));
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = dir.join(format!("label-{}.zpl", Utc::now().format("%Y%m%d%H%M%S%.3f")));
    fs::write(&path, zpl).map_err(|err| err.to_string())?;
    Ok(format!("ZPL salvo em {}", path.display()))
}

fn print_tcp(printer: &PrinterConfig, zpl: &str) -> Result<String, String> {
    let host = printer.host.as_ref().ok_or_else(|| "Host TCP nao configurado.".to_string())?;
    let port = printer.port.unwrap_or(9100);
    let mut stream = TcpStream::connect((host.as_str(), port)).map_err(|err| err.to_string())?;
    stream.write_all(zpl.as_bytes()).map_err(|err| err.to_string())?;
    stream.flush().map_err(|err| err.to_string())?;
    Ok(format!("ZPL enviado para {host}:{port}"))
}

fn print_windows_spooler(printer: &PrinterConfig, zpl: &str) -> Result<String, String> {
    let queue = printer
        .queue_name
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Fila Windows nao configurada.".to_string())?;
    let temp_dir = app_dir()?.join("spool");
    fs::create_dir_all(&temp_dir).map_err(|err| err.to_string())?;
    let file = temp_dir.join(format!("raw-{}.zpl", Utc::now().format("%Y%m%d%H%M%S%.3f")));
    fs::write(&file, zpl).map_err(|err| err.to_string())?;

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "$bytes=[System.IO.File]::ReadAllBytes('{}'); $text=[System.Text.Encoding]::ASCII.GetString($bytes); $text | Out-Printer -Name '{}'",
            file.display().to_string().replace('\'', "''"),
            queue.replace('\'', "''")
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .output()
            .map_err(|err| err.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Falha ao enviar para fila Windows: {stderr}"));
        }
        Ok(format!("ZPL enviado para fila Windows {queue}"))
    }

    #[cfg(not(target_os = "windows"))]
    Err("Fila Windows disponivel apenas no Windows.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dry_run_writes_zpl_file() {
        let printer = PrinterConfig {
            mode: "dry_run".to_string(),
            local_id: "test".to_string(),
            queue_name: None,
            host: None,
            port: None,
            dry_run_dir: None,
        };
        let result = print_zpl(&printer, "^XA^XZ").unwrap();
        assert!(result.contains(".zpl"));
    }
}
