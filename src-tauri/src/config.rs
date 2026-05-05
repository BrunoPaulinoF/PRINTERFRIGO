use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleConfig {
    pub mode: Option<String>,
    pub port: String,
    pub host: Option<String>,
    pub simulated_weight_kg: Option<f64>,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub read_command: Option<String>,
    pub parser_regex: String,
    pub stable_window: usize,
    pub stable_threshold_kg: f64,
    pub stable_ms: u64,
    pub min_weight_kg: f64,
    pub cooldown_ms: u64,
    pub zero_threshold_kg: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterConfig {
    pub mode: String,
    pub local_id: String,
    pub queue_name: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub dry_run_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StationConfig {
    pub server_url: String,
    pub agent_id: Option<String>,
    pub tenant_id: Option<String>,
    pub token: Option<String>,
    pub station_label: String,
    pub app_version: String,
    pub scale: ScaleConfig,
    pub printer: PrinterConfig,
    #[serde(default)]
    pub scales: Vec<ScaleConfig>,
    #[serde(default)]
    pub printers: Vec<PrinterConfig>,
}

pub fn app_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or_else(|| "Nao foi possivel localizar AppData local.".to_string())?;
    Ok(base.join("PRINTERFRIGO"))
}

fn db_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("printerfrigo.sqlite3"))
}

pub fn connection() -> Result<Connection, String> {
    init_storage()?;
    Connection::open(db_path()?).map_err(|err| err.to_string())
}

pub fn init_storage() -> Result<(), String> {
    fs::create_dir_all(app_dir()?).map_err(|err| err.to_string())?;
    let conn = Connection::open(db_path()?).map_err(|err| err.to_string())?;
    conn.execute_batch(
        r#"
        create table if not exists config (
          key text primary key,
          value text not null,
          updated_at text not null default current_timestamp
        );
        create table if not exists outbound_queue (
          id text primary key,
          kind text not null,
          payload text not null,
          status text not null default 'pending',
          attempts integer not null default 0,
          created_at text not null default current_timestamp,
          updated_at text not null default current_timestamp
        );
        create table if not exists local_logs (
          id integer primary key autoincrement,
          level text not null,
          message text not null,
          context text,
          created_at text not null default current_timestamp
        );
        "#,
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_config() -> Result<Option<StationConfig>, String> {
    let conn = connection()?;
    let mut stmt = conn
        .prepare("select value from config where key = 'station'")
        .map_err(|err| err.to_string())?;
    let mut rows = stmt.query([]).map_err(|err| err.to_string())?;
    if let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let value: String = row.get(0).map_err(|err| err.to_string())?;
        serde_json::from_str(&value).map(Some).map_err(|err| err.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn save_config(config: StationConfig) -> Result<(), String> {
    let value = serde_json::to_string(&config).map_err(|err| err.to_string())?;
    let conn = connection()?;
    conn.execute(
        "insert into config (key, value, updated_at) values ('station', ?1, current_timestamp)
         on conflict(key) do update set value = excluded.value, updated_at = current_timestamp",
        params![value],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}
