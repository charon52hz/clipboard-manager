#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use arboard::Clipboard;
use image::GenericImageView;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

// ======================== Data Types ========================

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClipboardItem {
    id: i64,
    r#type: String,
    content: Option<String>,
    image_path: Option<String>,
    preview: Option<String>,
    created_at: Option<String>,
    pinned: Option<i32>,
}

struct AppState {
    db: Arc<Mutex<Connection>>,
}

// ======================== Database ========================

fn init_db(db_path: &PathBuf) -> Connection {
    let conn = Connection::open(db_path).expect("Failed to open database");
    conn.execute_batch("PRAGMA journal_mode=WAL").ok();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS clipboard_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            content TEXT,
            image_path TEXT,
            preview TEXT,
            created_at DATETIME DEFAULT (datetime('now','localtime')),
            pinned INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_created_at
            ON clipboard_history(created_at DESC);",
    )
    .expect("Failed to init database");
    conn
}

fn db_add(conn: &Connection, item_type: &str, content: Option<&str>, image_path: Option<&str>, preview: &str) {
    conn.execute(
        "INSERT INTO clipboard_history (type, content, image_path, preview) VALUES (?1, ?2, ?3, ?4)",
        params![item_type, content, image_path, preview],
    )
    .ok();

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM clipboard_history", [], |r| r.get(0))
        .unwrap_or(0);
    if count > 500 {
        conn.execute(
            "DELETE FROM clipboard_history WHERE id NOT IN (SELECT id FROM clipboard_history ORDER BY created_at DESC LIMIT 500)",
            [],
        )
        .ok();
    }
}

fn db_get_all(conn: &Connection, limit: i64) -> Vec<ClipboardItem> {
    let mut stmt = conn
        .prepare("SELECT id, type, content, image_path, preview, created_at, pinned FROM clipboard_history ORDER BY pinned DESC, created_at DESC LIMIT ?1")
        .unwrap();
    stmt.query_map(params![limit], |row| {
        Ok(ClipboardItem {
            id: row.get(0)?,
            r#type: row.get(1)?,
            content: row.get(2)?,
            image_path: row.get(3)?,
            preview: row.get(4)?,
            created_at: row.get(5)?,
            pinned: row.get(6)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

fn db_delete(conn: &Connection, id: i64) {
    if let Ok(path) = conn.query_row(
        "SELECT image_path FROM clipboard_history WHERE id = ?1",
        params![id],
        |r| r.get::<_, Option<String>>(0),
    ) {
        if let Some(p) = path {
            fs::remove_file(p).ok();
        }
    }
    conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])
        .ok();
}

fn db_clear(conn: &Connection) {
    let paths: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT image_path FROM clipboard_history WHERE image_path IS NOT NULL")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    };
    for p in paths {
        fs::remove_file(p).ok();
    }
    conn.execute("DELETE FROM clipboard_history", []).ok();
}

fn db_toggle_pin(conn: &Connection, id: i64) {
    if let Ok(pinned) = conn.query_row(
        "SELECT pinned FROM clipboard_history WHERE id = ?1",
        params![id],
        |r| r.get::<_, i32>(0),
    ) {
        let new_val = if pinned == 0 { 1 } else { 0 };
        conn.execute(
            "UPDATE clipboard_history SET pinned = ?1 WHERE id = ?2",
            params![new_val, id],
        )
        .ok();
    }
}

// ======================== Clipboard Monitor ========================

fn start_monitor(app: AppHandle, db: Arc<Mutex<Connection>>, image_dir: PathBuf) {
    std::thread::spawn(move || {
        let mut clip = match Clipboard::new() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut last_text = String::new();
        let mut last_img_size: usize = 0;

        loop {
            std::thread::sleep(Duration::from_millis(800));

            // Text
            if let Ok(text) = clip.get_text() {
                if !text.is_empty() && text != last_text {
                    last_text = text.clone();
                    if let Ok(conn) = db.lock() {
                        let latest = conn.query_row(
                            "SELECT type, content FROM clipboard_history ORDER BY created_at DESC LIMIT 1",
                            [],
                            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
                        );
                        if let Ok((t, c)) = latest {
                            if t == "text" && c.as_deref() == Some(&text) {
                                continue;
                            }
                        }
                        let preview = if text.len() > 200 { &text[..200] } else { &text };
                        db_add(&conn, "text", Some(&text), None, preview);
                    }
                    app.emit("clipboard-changed", ()).ok();
                }
            }

            // Image
            if let Ok(img) = clip.get_image() {
                let bytes = img.bytes.len();
                if bytes > 0 && bytes != last_img_size {
                    last_img_size = bytes;
                    let filename = format!("clip_{}.png", chrono_now());
                    let path = image_dir.join(&filename);
                    let w = img.width as u32;
                    let h = img.height as u32;
                    if let Some(buf) = image::ImageBuffer::from_raw(w, h, img.bytes.to_vec()) {
                        let rgba = image::DynamicImage::ImageRgba8(buf);
                        if rgba.save(&path).is_ok() {
                            if let Ok(conn) = db.lock() {
                                let preview = format!("[图片 {}KB]", bytes / 1024);
                                db_add(
                                    &conn,
                                    "image",
                                    None,
                                    Some(path.to_str().unwrap_or("")),
                                    &preview,
                                );
                            }
                            app.emit("clipboard-changed", ()).ok();
                        }
                    }
                }
            }
        }
    });
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".into())
}

// ======================== Commands ========================

#[tauri::command]
fn get_history(state: tauri::State<AppState>) -> Vec<ClipboardItem> {
    let conn = state.db.lock().unwrap();
    db_get_all(&conn, 100)
}

#[tauri::command]
fn copy_item(item: ClipboardItem, app: AppHandle) {
    let mut clip = match Clipboard::new() {
        Ok(c) => c,
        Err(_) => return,
    };
    match item.r#type.as_str() {
        "text" => {
            if let Some(ref text) = item.content {
                clip.set_text(text.as_str()).ok();
            }
        }
        "image" => {
            if let Some(ref path) = item.image_path {
                if let Ok(img) = image::open(path) {
                    let rgba = img.to_rgba8();
                    let (w, h) = rgba.dimensions();
                    clip.set_image(arboard::ImageData {
                        bytes: rgba.into_raw().into(),
                        width: w as usize,
                        height: h as usize,
                    })
                    .ok();
                }
            }
        }
        _ => {}
    }
    // 延迟 500ms 隐藏窗口，让视觉反馈有时间渲染
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(w) = app.get_webview_window("main") {
            w.hide().ok();
        }
    });
}

#[tauri::command]
fn delete_item(state: tauri::State<AppState>, id: i64) {
    let conn = state.db.lock().unwrap();
    db_delete(&conn, id);
}

#[tauri::command]
fn toggle_pin(state: tauri::State<AppState>, id: i64) {
    let conn = state.db.lock().unwrap();
    db_toggle_pin(&conn, id);
}

#[tauri::command]
fn clear_history(state: tauri::State<AppState>, app: AppHandle) {
    let conn = state.db.lock().unwrap();
    db_clear(&conn);
    app.emit("clipboard-changed", ()).ok();
}

#[tauri::command]
fn get_image_data(image_path: String) -> Option<String> {
    fs::read(&image_path)
        .ok()
        .map(|buf| format!("data:image/png;base64,{}", base64_encode(&buf)))
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[(n >> 18 & 63) as usize] as char);
        result.push(CHARS[(n >> 12 & 63) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[(n >> 6 & 63) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(n & 63) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ======================== Main ========================

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // App data directories
            let data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            fs::create_dir_all(&data_dir).ok();
            let image_dir = data_dir.join("clipboard_images");
            fs::create_dir_all(&image_dir).ok();

            // Database
            let db_path = data_dir.join("clipboard.db");
            let conn = init_db(&db_path);
            let db = Arc::new(Mutex::new(conn));

            // State
            app.manage(AppState { db: db.clone() });

            // Clipboard monitor
            start_monitor(app_handle.clone(), db.clone(), image_dir);

            // Tray menu
            let show_item = MenuItemBuilder::with_id("show", "打开剪贴板历史").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // Tray icon
            let icon_bytes = include_bytes!("../icons/icon.png");
            let tray_icon = image::load_from_memory(icon_bytes).ok().map(|img| {
                let (w, h) = img.dimensions();
                let rgba = img.to_rgba8().into_raw();
                Image::new_owned(rgba, w, h)
            });

            let mut tray_builder = TrayIconBuilder::new();
            if let Some(ref icon) = tray_icon {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder
                .icon_as_template(true)
                .tooltip("剪贴板管理器")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                w.hide().ok();
                            } else {
                                w.show().ok();
                                w.set_focus().ok();
                            }
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                w.hide().ok();
                            } else {
                                w.show().ok();
                                w.set_focus().ok();
                            }
                        }
                    }
                })
                .build(app)?;

            // Global shortcut Cmd+Shift+V / Ctrl+Shift+V
            use tauri_plugin_global_shortcut::ShortcutState;
            app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+V", move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("main") {
                        if w.is_visible().unwrap_or(false) {
                            w.hide().ok();
                        } else {
                            w.show().ok();
                            w.set_focus().ok();
                        }
                    }
                }
            })?;

            // Hide window on blur
            if let Some(w) = app.get_webview_window("main") {
                let win = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        win.hide().ok();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history,
            copy_item,
            delete_item,
            toggle_pin,
            clear_history,
            get_image_data,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run app");
}
