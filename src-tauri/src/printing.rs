use crate::config::{app_dir, PrinterConfig};
use chrono::Utc;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::{io, ptr};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    name: String,
    is_default: bool,
}

#[tauri::command]
pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Printer | Sort-Object Name | ForEach-Object { \"$($_.Name)`t$($_.Default)\" }",
            ])
            .output()
            .map_err(|err| err.to_string())?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Ok(parse_printer_rows(&stdout));
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

    #[cfg(target_os = "windows")]
    {
        send_raw_to_windows_printer(queue, zpl.as_bytes())?;
        Ok(format!("Etiqueta ZPL enviada para fila Windows {queue}"))
    }

    #[cfg(not(target_os = "windows"))]
    Err("Fila Windows disponivel apenas no Windows.".to_string())
}

fn parse_printer_rows(stdout: &str) -> Vec<PrinterInfo> {
    stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let mut parts = trimmed.splitn(2, '\t');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let is_default = parts
                .next()
                .map(|value| value.trim().eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            Some(PrinterInfo { name: name.to_string(), is_default })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn send_raw_to_windows_printer(queue: &str, data: &[u8]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, DOC_INFO_1W, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW, StartPagePrinter,
        WritePrinter,
    };

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    unsafe {
        let queue_w = wide(queue);
        let mut handle: HANDLE = ptr::null_mut();
        if OpenPrinterW(queue_w.as_ptr(), &mut handle, ptr::null()) == 0 {
            return Err(format!("Nao foi possivel abrir a fila Windows '{queue}': {}", io::Error::last_os_error()));
        }

        let doc_name = wide("PRINTERFRIGO Etiqueta ZPL");
        let datatype = wide("RAW");
        let doc_info = DOC_INFO_1W {
            pDocName: doc_name.as_ptr() as *mut u16,
            pOutputFile: ptr::null_mut(),
            pDatatype: datatype.as_ptr() as *mut u16,
        };

        if StartDocPrinterW(handle, 1, &doc_info) == 0 {
            let error = io::Error::last_os_error();
            ClosePrinter(handle);
            return Err(format!("Nao foi possivel iniciar job RAW na impressora '{queue}': {error}"));
        }

        if StartPagePrinter(handle) == 0 {
            let error = io::Error::last_os_error();
            EndDocPrinter(handle);
            ClosePrinter(handle);
            return Err(format!("Nao foi possivel iniciar pagina na impressora '{queue}': {error}"));
        }

        let mut written = 0_u32;
        if WritePrinter(handle, data.as_ptr().cast(), data.len() as u32, &mut written) == 0 || written != data.len() as u32 {
            let error = io::Error::last_os_error();
            EndPagePrinter(handle);
            EndDocPrinter(handle);
            ClosePrinter(handle);
            return Err(format!("Nao foi possivel enviar ZPL RAW para '{queue}': {error}"));
        }

        EndPagePrinter(handle);
        EndDocPrinter(handle);
        ClosePrinter(handle);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dry_run_writes_zpl_file() {
        let dir = std::env::temp_dir().join(format!("printerfrigo-test-{}", uuid::Uuid::new_v4()));
        let printer = PrinterConfig {
            mode: "dry_run".to_string(),
            local_id: "test".to_string(),
            queue_name: None,
            host: None,
            port: None,
            dry_run_dir: Some(dir.display().to_string()),
        };
        let result = print_zpl(&printer, "^XA^XZ").unwrap();
        assert!(result.contains(".zpl"));
    }

    #[test]
    fn parses_windows_printer_rows_with_default_marker() {
        let rows = parse_printer_rows("ZDesigner ZD220\tTrue\nPDF Writer\tFalse\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "ZDesigner ZD220");
        assert!(rows[0].is_default);
        assert!(!rows[1].is_default);
    }
}
