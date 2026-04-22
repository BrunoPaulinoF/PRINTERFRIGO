use crate::config::connection;
use rusqlite::params;
use serde_json::Value;
use uuid::Uuid;

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
    Ok(())
}
