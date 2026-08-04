mod config;
mod hardware;
mod printing;
mod queue;
mod system;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_updater::UpdaterExt;

/// Resultado da checagem manual de atualizacao exposta para o frontend.
#[derive(serde::Serialize)]
struct UpdateStatus {
    available: bool,
    version: Option<String>,
    current: String,
}

/// Apenas verifica se ha atualizacao; NAO instala nada.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|err| err.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateStatus {
            available: true,
            version: Some(update.version.clone()),
            current,
        }),
        Ok(None) => Ok(UpdateStatus {
            available: false,
            version: None,
            current,
        }),
        Err(err) => Err(err.to_string()),
    }
}

/// Baixa e instala a atualizacao (se houver) e reinicia o app.
/// So e chamado depois de o usuario confirmar no botao.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    if let Some(update) = updater.check().await.map_err(|err| err.to_string())? {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|err| err.to_string())?;
        app.restart();
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            config::init_storage().map_err(|err| err.to_string())?;

            let show = MenuItem::with_id(app, "show", "Abrir", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Fechar", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            if let Some(window) = app.get_webview_window("main") {
                let window_to_hide = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_to_hide.hide();
                    }
                });
            }

            let mut tray_builder = TrayIconBuilder::new()
                .tooltip("PrinterFrigo")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            tray_builder.build(app)?;

            if std::env::args().any(|arg| arg == "--minimized") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            // Atualizacao NAO e mais automatica: o usuario dispara manualmente
            // pelos comandos check_update / install_update (botao na UI).

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            system::ensure_windows_autostart,
            config::load_config,
            config::save_config,
            hardware::auto_configure_scale_serial,
            hardware::enroll_agent,
            hardware::fetch_realtime_token,
            hardware::heartbeat_once,
            hardware::list_serial_ports,
            hardware::read_scale_once,
            hardware::read_scale_raw,
            hardware::read_scale_stable,
            hardware::report_print_job,
            hardware::submit_capture,
            hardware::test_scale_parse,
            queue::delete_pending_capture_submit,
            queue::delete_pending_print_job_report,
            queue::list_pending_capture_submits,
            queue::list_pending_print_job_reports,
            queue::save_pending_capture_submit,
            queue::save_pending_print_job_report,
            printing::list_printers,
            printing::test_print_zpl,
            printing::quick_reset_printers,
            queue::list_local_logs,
            queue::write_local_log,
            check_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao executar PrinterFrigo");
}
