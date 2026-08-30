// NOTE: this sandbox has no Rust toolchain, so this file has been written
// carefully against the Tauri v2 API as I know it but has NOT been run
// through `cargo check` anywhere. Do that first thing after `npm install`.
// The two spots most likely to need a small fix if the API has moved since
// my knowledge cutoff (Jan 2026) are marked below -- Tauri's compiler errors
// are usually specific enough to fix directly from the message.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, PhysicalPosition, Position, WindowEvent,
};

/// Exposed to the frontend for later phases (e.g. a keyboard shortcut or a
/// HUD button) even though only the tray menu drives it in Phase 1.
#[tauri::command]
fn toggle_click_through(window: tauri::WebviewWindow, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![toggle_click_through])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window must exist -- check the label in tauri.conf.json");

            anchor_bottom_right(&window);
            build_tray(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Luna is meant to live in the tray, not get closed by accident.
            // The only real "quit" is the tray menu's Quit item.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Luna");
}

/// Places the window in the bottom-right corner of the primary monitor on
/// first launch, with a small margin, instead of wherever Tauri defaults to.
fn anchor_bottom_right(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let Ok(win_size) = window.outer_size() else {
        return;
    };

    let screen = monitor.size();
    let margin: i32 = 24;
    let x = screen.width as i32 - win_size.width as i32 - margin;
    let y = screen.height as i32 - win_size.height as i32 - margin;

    let _ = window.set_position(Position::Physical(PhysicalPosition { x, y }));
}

/// Tray icon + menu: Show/Hide, Toggle Click-through, Quit.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_hide = MenuItem::with_id(app, "show_hide", "Show/Hide Luna", true, None::<&str>)?;
    let click_through = MenuItem::with_id(
        app,
        "click_through",
        "Toggle Click-through",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_hide, &click_through, &quit])?;

    // Interior mutability instead of a mutable capture: on_menu_event's
    // closure is `Fn`, not `FnMut` (it may be invoked from more than one
    // call site), so a plain `let mut` captured by the closure won't compile.
    let click_through_state = Arc::new(AtomicBool::new(false));

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(move |app, event| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            match event.id().as_ref() {
                "show_hide" => {
                    let visible = window.is_visible().unwrap_or(true);
                    let _ = if visible { window.hide() } else { window.show() };
                }
                "click_through" => {
                    let now_ignoring = !click_through_state.load(Ordering::Relaxed);
                    click_through_state.store(now_ignoring, Ordering::Relaxed);
                    let _ = window.set_ignore_cursor_events(now_ignoring);
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}
