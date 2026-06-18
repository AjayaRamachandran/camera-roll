fn main() {
    // Rebuild (and re-embed the Windows exe icon) whenever the icons change.
    // Cargo does not track these by default, so a bare icon swap would otherwise
    // reuse the stale binary and the taskbar icon would not update.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");

    // Generates Tauri's context (parses tauri.conf.json, embeds assets, etc.).
    tauri_build::build();
}
