use crate::config::connection;
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogEntry {
    id: i64,
    level: String,
    message: String,
    context: Option<String>,
    created_at: String,
}

#[allow(dead_code)]
pub fn enqueue(kind: &str, payload: &Value) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let conn = connection()?;
    conn.execute(
        "insert into outbound_queue (id, kind, payload) values (?1, ?2, ?3)",
        params![id, kind, payload.to_string()],
    )
    .map_err(|err| err.to_string())?;
    Ok(id)
}

#[allow(dead_code)]
pub fn log(level: &str, message: &str, context: Option<&Value>) -> Result<(), String> {
    let conn = connection()?;
    conn.execute(
        "insert into local_logs (level, message, context) values (?1, ?2, ?3)",
        params![level, message, context.map(Value::to_string)],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "delete from local_logs where id not in (select id from local_logs order by id desc limit 500)",
        [],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn write_local_log(level: String, message: String, context: Option<Value>) -> Result<(), String> {
    log(&level, &message, context.as_ref())
}

#[tauri::command]
pub fn list_local_logs(limit: Option<i64>) -> Result<Vec<LocalLogEntry>, String> {
    let safe_limit = limit.unwrap_or(50).clamp(1, 200);
    let conn = connection()?;
    let mut stmt = conn
        .prepare(
            "select id, level, message, context, created_at
             from local_logs
             order by id desc
             limit ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![safe_limit], |row| {
            Ok(LocalLogEntry {
                id: row.get(0)?,
                level: row.get(1)?,
                message: row.get(2)?,
                context: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}
