// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Thin entry point. All real logic lives in the library crate so it can be
// reused (e.g. for mobile targets) and unit-tested independently.
fn main() {
    photoviewer_lib::run();
}
