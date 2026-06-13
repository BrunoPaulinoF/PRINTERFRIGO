use crate::config::connection;
use rusqlite::params;
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPrintJobReport {
    job_id: String,
    status: String,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCaptureSubmit {
    capture_id: String,
    session_id: String,
    point_id: String,
    flow: String,
    gross_weight: f64,
    stable: bool,
    payload: Value,
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

fn upsert_outbound(id: &str, kind: &str, payload: &Value) -> Result<(), String> {
    let conn = connection()?;
    conn.execute(
        "insert into outbound_queue (id, kind, payload, status, updated_at)
         values (?1, ?2, ?3, 'pending', current_timestamp)
         on conflict(id) do update set payload = excluded.payload, status = 'pending', attempts = outbound_queue.attempts + 1, updated_at = current_timestamp",
        params![id, kind, payload.to_string()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn list_outbound<T: for<'de> Deserialize<'de>>(kind: &str) -> Result<Vec<T>, String> {
    let conn = connection()?;
    let mut stmt = conn
        .prepare(
            "select payload
             from outbound_queue
             where kind = ?1 and status = 'pending'
             order by created_at asc",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![kind], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        let payload = row.map_err(|err| err.to_string())?;
        out.push(serde_json::from_str::<T>(&payload).map_err(|err| err.to_string())?);
    }
    Ok(out)
}

fn delete_outbound(id: &str, kind: &str) -> Result<(), String> {
    let conn = connection()?;
    conn.execute("delete from outbound_queue where id = ?1 and kind = ?2", params![id, kind])
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn save_pending_print_job_report(job_id: String, status: String, error: Option<String>) -> Result<(), String> {
    let payload = serde_json::to_value(PendingPrintJobReport { job_id: job_id.clone(), status, error })
        .map_err(|err| err.to_string())?;
    upsert_outbound(&format!("print-job-report:{job_id}"), "print_job_report", &payload)
}

#[tauri::command]
pub fn list_pending_print_job_reports() -> Result<Vec<PendingPrintJobReport>, String> {
    list_outbound("print_job_report")
}

#[tauri::command]
pub fn delete_pending_print_job_report(job_id: String) -> Result<(), String> {
    delete_outbound(&format!("print-job-report:{job_id}"), "print_job_report")
}

#[tauri::command]
pub fn save_pending_capture_submit(capture_id: String, request: PendingCaptureSubmit) -> Result<(), String> {
    let payload = serde_json::to_value(request).map_err(|err| err.to_string())?;
    upsert_outbound(&format!("capture-submit:{capture_id}"), "capture_submit", &payload)
}

#[tauri::command]
pub fn list_pending_capture_submits() -> Result<Vec<PendingCaptureSubmit>, String> {
    list_outbound("capture_submit")
}

#[tauri::command]
pub fn delete_pending_capture_submit(capture_id: String) -> Result<(), String> {
    delete_outbound(&format!("capture-submit:{capture_id}"), "capture_submit")
}
