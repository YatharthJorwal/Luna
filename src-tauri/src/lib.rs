// NOTE: this sandbox has no Rust toolchain, so this file was originally
// written against the Tauri v2 API from memory and unverified. The
// global-shortcut block below has since been through a real `cargo build`
// on the user's machine and fixed once (see docs/DECISIONS.md for the
// E0277 error and fix) -- everything else in this file is still unverified
// the same way it always has been.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, PhysicalPosition, Position, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

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
            register_push_to_talk_hotkey(app)?;

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

/// F9 push-to-talk: registered as an OS-level global shortcut, so it works
/// regardless of which window has focus (a game, a browser, whatever) --
/// unlike a plain keydown listener in the frontend, which only fires while
/// Luna's own window is focused, defeating the point of an always-on-top
/// desktop companion you talk to while doing something else. Emits a
/// "hotkey-talk" event with "pressed"/"released" as the payload; the
/// frontend (src/mic.ts, wired up in src/main.ts) does the actual recording
/// start/stop, same as a mic-button click -- this function's only job is
/// turning a raw key event into that event.
fn register_push_to_talk_hotkey(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .expect("main window must exist -- check the label in tauri.conf.json");

    let push_to_talk = Shortcut::new(None, Code::F9);
    let shortcut_for_handler = push_to_talk.clone();

    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, scut, event| {
                if scut != &shortcut_for_handler {
                    return;
                }
                let state = match event.state() {
                    ShortcutState::Pressed => "pressed",
                    ShortcutState::Released => "released",
                };
                let _ = window.emit("hotkey-talk", state);
            })
            .build(),
    )?;

    app.global_shortcut().register(push_to_talk)?;

    Ok(())
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
