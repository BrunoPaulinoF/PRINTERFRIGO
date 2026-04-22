mod config;
mod hardware;
mod printing;
mod queue;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            config::init_storage().map_err(|err| err.to_string())?;

            let show = MenuItem::with_id(app, "show", "Abrir", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .tooltip("PRINTERFRIGO")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            hardware::enroll_agent,
            hardware::heartbeat_once,
            hardware::list_serial_ports,
            hardware::read_scale_once,
            hardware::test_scale_parse,
            printing::list_printers,
            printing::test_print_zpl,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao executar PRINTERFRIGO");
}
