mod admin_ai;
mod config;
mod hardware;
mod printing;
mod queue;

#[cfg(not(debug_assertions))]
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
#[cfg(not(debug_assertions))]
use tauri_plugin_updater::UpdaterExt;

pub fn run() {
    tauri::Builder::default()
        .manage(admin_ai::AdminState::default())
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
                .tooltip("PRINTERFRIGO")
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

            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    match handle.updater() {
                        Ok(updater) => match updater.check().await {
                            Ok(Some(update)) => {
                                let _ = update.download_and_install(|_, _| {}, || {}).await;
                            }
                            Ok(None) => {}
                            Err(err) => eprintln!("Falha ao checar update: {err}"),
                        },
                        Err(err) => eprintln!("Falha ao inicializar updater: {err}"),
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            admin_ai::admin_login,
            admin_ai::admin_logout,
            admin_ai::admin_status,
            admin_ai::ensure_windows_autostart,
            admin_ai::ai_collect_snapshot,
            admin_ai::ai_run_local_tool,
            admin_ai::ai_save_station_config,
            config::load_config,
            config::save_config,
            hardware::enroll_agent,
            hardware::fetch_realtime_token,
            hardware::heartbeat_once,
            hardware::list_serial_ports,
            hardware::read_scale_once,
            hardware::report_print_job,
            hardware::submit_capture,
            hardware::test_scale_parse,
            printing::list_printers,
            printing::test_print_zpl,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao executar PRINTERFRIGO");
}
