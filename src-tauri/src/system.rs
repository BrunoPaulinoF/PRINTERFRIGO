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
        run.set_value("PrinterFrigo", &command)
            .map_err(|err| err.to_string())?;
        Ok("Inicializacao com Windows ativada.".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    Ok("Autostart e aplicado apenas no Windows.".to_string())
}
