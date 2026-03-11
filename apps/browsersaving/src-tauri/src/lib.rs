use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
#[cfg(target_os = "macos")]
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

const MOBILE_SIMULATOR_EXT_URL: &str = "https://chromewebstore.google.com/detail/mobile-simulator-responsi/ckejmhbmlajgoklhgbapkiccekfoccmk";
const DEFAULT_ANDROID_SDK_DIR: &str = "Library/Android/sdk";
const ANDROID_AVD_ENV_KEY: &str = "BROWSERSAVING_ANDROID_AVD";
const ANDROID_PROFILE_META_FILE: &str = "android-profile-meta.json";
const ANDROID_SYNC_MAX_MB_DEFAULT: u64 = 300;

// Server URL - configurable via environment
fn get_server_url() -> String {
    std::env::var("SERVER_URL").unwrap_or_else(|_| {
        "https://browsersaving-worker.yokthanwa1993-bc9.workers.dev".to_string()
    })
}

// Profile structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub proxy: String,
    pub homepage: Option<String>,
    pub notes: String,
    pub tags: Option<Vec<String>>,
    pub avatar_url: Option<String>,
    pub totp_secret: Option<String>,
    #[serde(default)]
    pub uid: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

fn get_mobile_simulator_extension_dir() -> Option<PathBuf> {
    if let Ok(custom_path) = std::env::var("MOBILE_SIMULATOR_EXTENSION_DIR") {
        let path = PathBuf::from(custom_path.trim());
        if path.join("manifest.json").exists() {
            return Some(path);
        }
    }

    let project_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("extension/Mobile simulator - responsive testing tool"));
    if let Some(ref ext_path) = project_path {
        if ext_path.join("manifest.json").exists() {
            return Some(ext_path.clone());
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(app_dir) = exe_path.parent() {
            let resources = app_dir.parent().map(|p| {
                vec![
                    p.join("Resources/mobile-simulator-extension"),
                    p.join("Resources/resources/mobile-simulator-extension"),
                ]
            });
            if let Some(resource_candidates) = resources {
                for ext_path in resource_candidates {
                    if ext_path.join("manifest.json").exists() {
                        return Some(ext_path);
                    }
                }
            }
        }
    }

    let dev_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/mobile-simulator-extension");
    if dev_path.join("manifest.json").exists() {
        return Some(dev_path);
    }

    let cache_path = dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("BrowserSaving")
        .join("extensions")
        .join("mobile-simulator-extension");
    if cache_path.join("manifest.json").exists() {
        return Some(cache_path);
    }

    if let Some(download_dir) = dirs::download_dir() {
        if let Some(path) = find_mobile_simulator_extension_in_dir(&download_dir, true) {
            return Some(path);
        }
    }

    if let Some(home_dir) = dirs::home_dir() {
        let downloads_like = home_dir.join("Downloads");
        if let Some(path) = find_mobile_simulator_extension_in_dir(&downloads_like, false) {
            return Some(path);
        }
    }

    None
}

fn looks_like_mobile_simulator_extension_dir(path: &Path) -> bool {
    let manifest_path = path.join("manifest.json");
    let background_path = path.join("js/background.js");

    if !manifest_path.is_file() || !background_path.is_file() {
        return false;
    }

    let manifest = match fs::read_to_string(&manifest_path) {
        Ok(contents) => contents,
        Err(_) => return false,
    };

    let has_localized_name = manifest.contains("__MSG_extName__");
    let has_worker = manifest.contains("\"service_worker\": \"js/background.js\"");

    has_localized_name && (has_worker || manifest.contains("\"background\""))
}

fn find_mobile_simulator_extension_in_dir(root: &Path, scan_nested: bool) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    let mut generic_match: Option<PathBuf> = None;

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        if looks_like_mobile_simulator_extension_dir(&path) {
            if is_extension_folder_name_like_mobile_simulator(&path) {
                return Some(path);
            }
            if generic_match.is_none() {
                generic_match = Some(path.clone());
            }
        }

        if scan_nested {
            let Ok(nested) = fs::read_dir(&path) else {
                continue;
            };
            for child in nested.filter_map(Result::ok) {
                let child_path = child.path();
                if !child_path.is_dir() {
                    continue;
                }
                if looks_like_mobile_simulator_extension_dir(&child_path)
                    && is_extension_folder_name_like_mobile_simulator(&child_path)
                {
                    return Some(child_path);
                }
            }
        }
    }

    generic_match
}

fn is_extension_folder_name_like_mobile_simulator(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_lowercase();
    lower.contains("mobile")
        || lower.contains("simulator")
        || lower.contains("web")
        || lower.contains("chrome")
        || lower.contains("webstore")
        || lower.contains("มือถือ")
        || lower.contains("โทรศัพท์")
        || lower.contains("เว็บ")
        || lower.contains("จำลอง")
}

fn startup_extension_args() -> Vec<String> {
    let mut extension_paths: Vec<String> = vec![get_stealth_extension_dir().display().to_string()];

    if let Some(path) = get_mobile_simulator_extension_dir() {
        extension_paths.push(path.display().to_string());
    }

    let joined = extension_paths.join(",");
    vec![
        format!("--load-extension={}", joined),
        format!("--disable-extensions-except={}", joined),
    ]
}

/// Compute the Chrome extension ID from an unpacked extension's absolute path.
/// Chrome uses SHA-256 of the path, takes the first 32 hex characters,
/// and maps each hex digit (0-f) to a letter (a-p).
fn compute_chrome_extension_id(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let hash = hasher.finalize();
    let hex = format!("{:x}", hash);
    hex.chars()
        .take(32)
        .map(|c| {
            let digit = c.to_digit(16).unwrap_or(0) as u8;
            (b'a' + digit) as char
        })
        .collect()
}

/// Write pinned extension IDs into the Chrome profile Preferences file
/// so their icons appear on the toolbar instead of being hidden behind the puzzle piece.
fn pin_extensions_in_preferences(profile_cache_dir: &Path) {
    let default_dir = profile_cache_dir.join("Default");
    let _ = fs::create_dir_all(&default_dir);
    let prefs_path = default_dir.join("Preferences");

    // Collect extension IDs to pin
    let mut pin_ids: Vec<String> = Vec::new();

    if let Some(mobile_path) = get_mobile_simulator_extension_dir() {
        pin_ids.push(compute_chrome_extension_id(&mobile_path));
    }

    if pin_ids.is_empty() {
        return;
    }

    // Read existing preferences or create new
    let mut prefs: serde_json::Value = if prefs_path.exists() {
        match fs::read_to_string(&prefs_path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or(serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        }
    } else {
        serde_json::json!({})
    };

    // Set extensions.pinned_extensions
    let extensions = prefs
        .as_object_mut()
        .unwrap()
        .entry("extensions")
        .or_insert(serde_json::json!({}));
    let ext_obj = extensions.as_object_mut().unwrap();

    let pin_json: Vec<serde_json::Value> = pin_ids
        .iter()
        .map(|id| serde_json::Value::String(id.clone()))
        .collect();
    ext_obj.insert(
        "pinned_extensions".to_string(),
        serde_json::Value::Array(pin_json.clone()),
    );

    // Also set toolbar order so Chrome respects the pin
    ext_obj.insert("toolbar".to_string(), serde_json::Value::Array(pin_json));

    // Write back
    if let Ok(json_str) = serde_json::to_string_pretty(&prefs) {
        let _ = fs::write(&prefs_path, json_str);
        log::info!(
            "Pinned extensions {:?} in {}",
            pin_ids,
            prefs_path.display()
        );
    }
}

fn startup_urls(profile: &Profile) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();

    urls.push("chrome://extensions/".to_string());

    if get_mobile_simulator_extension_dir().is_none() {
        urls.push(MOBILE_SIMULATOR_EXT_URL.to_string());
    }

    if let Some(homepage) = profile.homepage.as_ref() {
        let homepage_trimmed = homepage.trim();
        if !homepage_trimmed.is_empty() && !urls.iter().any(|url| url == homepage_trimmed) {
            urls.push(homepage_trimmed.to_string());
        }
    }

    urls
}

fn get_android_emulator_path() -> Option<PathBuf> {
    for sdk_dir in get_android_sdk_dirs() {
        let emulator_bin = sdk_dir.join("emulator").join("emulator");
        if emulator_bin.exists() {
            return Some(emulator_bin);
        }
    }

    None
}

fn get_android_sdk_dirs() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(sdk_root) = std::env::var("ANDROID_SDK_ROOT") {
        let trimmed = sdk_root.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed));
        }
    }

    if let Ok(android_home) = std::env::var("ANDROID_HOME") {
        let trimmed = android_home.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed));
        }
    }

    if let Some(home_dir) = dirs::home_dir() {
        candidates.push(home_dir.join(DEFAULT_ANDROID_SDK_DIR));
    }

    let mut unique: Vec<PathBuf> = Vec::new();
    for path in candidates {
        if !unique.iter().any(|existing| existing == &path) {
            unique.push(path);
        }
    }
    unique
}

fn get_android_adb_path() -> Option<PathBuf> {
    if let Ok(adb_from_env) = std::env::var("ANDROID_ADB_PATH") {
        let path = PathBuf::from(adb_from_env.trim());
        if path.exists() {
            return Some(path);
        }
    }

    for sdk_dir in get_android_sdk_dirs() {
        let adb_bin = sdk_dir.join("platform-tools").join("adb");
        if adb_bin.exists() {
            return Some(adb_bin);
        }
    }

    None
}

fn list_available_avds(emulator_path: &PathBuf) -> Result<Vec<String>, String> {
    let output = Command::new(emulator_path)
        .arg("-list-avds")
        .output()
        .map_err(|e| format!("Failed to run emulator -list-avds: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("Cannot list Android AVDs: {}", detail));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let avds = stdout
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect::<Vec<_>>();

    Ok(avds)
}

fn run_adb_command(adb_path: &Path, serial: Option<&str>, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(adb_path);
    if let Some(serial_name) = serial {
        cmd.arg("-s").arg(serial_name);
    }
    cmd.args(args);

    let output = cmd
        .output()
        .map_err(|e| format!("Run adb command failed (args: {:?}): {}", args, e))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(format!("adb command failed (args: {:?}): {}", args, detail))
}

fn list_adb_emulator_serials(adb_path: &Path) -> Result<Vec<String>, String> {
    let output = run_adb_command(adb_path, None, &["devices"])?;
    let mut serials = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("List of devices attached") {
            continue;
        }

        let mut parts = trimmed.split_whitespace();
        let Some(serial) = parts.next() else {
            continue;
        };

        if serial.starts_with("emulator-") {
            serials.push(serial.to_string());
        }
    }

    Ok(serials)
}

fn extract_xml_attr(line: &str, attr: &str) -> Option<String> {
    let needle = format!(r#"{}=""#, attr);
    let start = line.find(&needle)? + needle.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn parse_bounds_center(bounds: &str) -> Option<(i32, i32)> {
    // bounds format: [x1,y1][x2,y2]
    let cleaned = bounds.trim();
    let part = cleaned.strip_prefix('[')?.strip_suffix(']')?;
    let (first, second) = part.split_once("][")?;
    let (x1, y1) = first.split_once(',')?;
    let (x2, y2) = second.split_once(',')?;

    let x1: i32 = x1.parse().ok()?;
    let y1: i32 = y1.parse().ok()?;
    let x2: i32 = x2.parse().ok()?;
    let y2: i32 = y2.parse().ok()?;

    Some(((x1 + x2) / 2, (y1 + y2) / 2))
}

fn find_node_center_with_keywords(ui_xml: &str, keywords: &[&str]) -> Option<(i32, i32)> {
    for line in ui_xml.lines() {
        if !line.contains("<node ") {
            continue;
        }

        let haystack = line.to_ascii_lowercase();
        if !keywords.iter().any(|keyword| haystack.contains(keyword)) {
            continue;
        }

        if let Some(bounds) = extract_xml_attr(line, "bounds") {
            if let Some(center) = parse_bounds_center(&bounds) {
                return Some(center);
            }
        }
    }
    None
}

fn get_screen_size_from_adb(adb_path: &Path, serial: &str) -> Option<(i32, i32)> {
    let output = run_adb_command(adb_path, Some(serial), &["shell", "wm", "size"]).ok()?;
    for line in output.lines() {
        let trimmed = line.trim();
        let value = if let Some((_, rest)) = trimmed.split_once(':') {
            rest.trim()
        } else {
            trimmed
        };
        if let Some((w, h)) = value.split_once('x') {
            let width = w.trim().parse::<i32>().ok()?;
            let height = h.trim().parse::<i32>().ok()?;
            if width > 0 && height > 0 {
                return Some((width, height));
            }
        }
    }
    None
}

fn encode_adb_text(raw: &str) -> String {
    let mut encoded = String::with_capacity(raw.len() + 8);

    for ch in raw.chars() {
        match ch {
            ' ' => encoded.push_str("%s"),
            '&' | '|' | '<' | '>' | ';' | '(' | ')' | '$' | '"' | '\'' | '\\' | '*' | '?' | '['
            | ']' | '{' | '}' | '!' | '#' | '+' | ',' | ':' | '=' | '@' | '%' => {
                encoded.push('\\');
                encoded.push(ch);
            }
            _ => encoded.push(ch),
        }
    }

    encoded
}

fn adb_tap(adb_path: &Path, serial: &str, x: i32, y: i32) -> Result<(), String> {
    let x_s = x.to_string();
    let y_s = y.to_string();
    run_adb_command(
        adb_path,
        Some(serial),
        &["shell", "input", "tap", x_s.as_str(), y_s.as_str()],
    )?;
    Ok(())
}

fn adb_input_text(adb_path: &Path, serial: &str, text: &str) -> Result<(), String> {
    let encoded = encode_adb_text(text);
    run_adb_command(
        adb_path,
        Some(serial),
        &["shell", "input", "text", encoded.as_str()],
    )?;
    Ok(())
}

fn adb_clear_focused_input(adb_path: &Path, serial: &str) {
    let _ = run_adb_command(
        adb_path,
        Some(serial),
        &["shell", "input", "keyevent", "123"],
    );
    for _ in 0..80 {
        let _ = run_adb_command(
            adb_path,
            Some(serial),
            &["shell", "input", "keyevent", "67"],
        );
    }
}

fn adb_dump_ui_xml(adb_path: &Path, serial: &str) -> Result<String, String> {
    run_adb_command(
        adb_path,
        Some(serial),
        &["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"],
    )?;
    run_adb_command(
        adb_path,
        Some(serial),
        &["shell", "cat", "/sdcard/window_dump.xml"],
    )
}

fn adb_is_package_installed(adb_path: &Path, serial: &str, package_name: &str) -> bool {
    match run_adb_command(
        adb_path,
        Some(serial),
        &["shell", "pm", "path", package_name],
    ) {
        Ok(output) => output.contains("package:"),
        Err(_) => false,
    }
}

fn get_apk_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("BrowserSaving")
        .join("apk-cache")
}

fn detect_local_facebook_apk() -> Option<PathBuf> {
    let pinned_apk = PathBuf::from("/Users/yok/Downloads/Facebook_548.1.0.51.64_APKPure.apk");
    if pinned_apk.exists() {
        return Some(pinned_apk);
    }

    if let Ok(path) = std::env::var("BROWSERSAVING_FACEBOOK_APK_PATH") {
        let candidate = PathBuf::from(path.trim());
        if candidate.exists() {
            return Some(candidate);
        }
    }

    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut candidate_dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidate_dirs.push(home.join("Downloads"));
        candidate_dirs.push(home.join("Desktop"));
    }

    for dir in candidate_dirs {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            let is_apk = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("apk"));
            if !is_apk {
                continue;
            }

            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !(file_name.contains("facebook")
                || file_name.contains("fb")
                || file_name.contains("com.facebook.katana"))
            {
                continue;
            }

            let modified = fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

            match &best {
                Some((best_time, _)) if modified <= *best_time => {}
                _ => best = Some((modified, path)),
            }
        }
    }

    best.map(|(_, path)| path)
}

fn download_facebook_apk_from_env_url() -> Result<Option<PathBuf>, String> {
    let Ok(url) = std::env::var("BROWSERSAVING_FACEBOOK_APK_URL") else {
        return Ok(None);
    };
    let url = url.trim();
    if url.is_empty() {
        return Ok(None);
    }

    let cache_dir = get_apk_cache_dir();
    fs::create_dir_all(&cache_dir).map_err(|e| format!("Create apk cache dir failed: {}", e))?;
    let output_path = cache_dir.join("facebook-latest.apk");

    let status = Command::new("curl")
        .args([
            "-fL",
            "--retry",
            "2",
            "--connect-timeout",
            "15",
            "-o",
            output_path.to_string_lossy().as_ref(),
            url,
        ])
        .status()
        .map_err(|e| format!("Run curl for facebook apk failed: {}", e))?;

    if !status.success() {
        return Err(format!(
            "Download facebook apk failed (curl exit: {})",
            status
        ));
    }

    if output_path.exists() {
        return Ok(Some(output_path));
    }

    Ok(None)
}

fn adb_install_apk(adb_path: &Path, serial: &str, apk_path: &Path) -> Result<(), String> {
    if !apk_path.exists() {
        return Err(format!("APK not found: {}", apk_path.display()));
    }

    let output = Command::new(adb_path)
        .arg("-s")
        .arg(serial)
        .arg("install")
        .arg("-r")
        .arg("-d")
        .arg(apk_path)
        .output()
        .map_err(|e| format!("Run adb install failed: {}", e))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(format!("adb install failed: {}", detail))
}

async fn ensure_facebook_app_installed(adb_path: &Path, serial: &str) -> Result<(), String> {
    const FACEBOOK_PACKAGE: &str = "com.facebook.katana";

    if adb_is_package_installed(adb_path, serial, FACEBOOK_PACKAGE) {
        return Ok(());
    }

    log::info!(
        "Facebook app missing on {}, trying install-existing",
        serial
    );
    let _ = run_adb_command(
        adb_path,
        Some(serial),
        &[
            "shell",
            "cmd",
            "package",
            "install-existing",
            FACEBOOK_PACKAGE,
        ],
    );

    if adb_is_package_installed(adb_path, serial, FACEBOOK_PACKAGE) {
        return Ok(());
    }

    if let Some(local_apk) = detect_local_facebook_apk() {
        log::info!(
            "Installing Facebook APK from local file for {}: {}",
            serial,
            local_apk.display()
        );
        if adb_install_apk(adb_path, serial, &local_apk).is_ok()
            && adb_is_package_installed(adb_path, serial, FACEBOOK_PACKAGE)
        {
            log::info!("Facebook app installed on {} from local APK", serial);
            return Ok(());
        }
    }

    match download_facebook_apk_from_env_url() {
        Ok(Some(downloaded_apk)) => {
            log::info!(
                "Installing Facebook APK from URL cache for {}: {}",
                serial,
                downloaded_apk.display()
            );
            if adb_install_apk(adb_path, serial, &downloaded_apk).is_ok()
                && adb_is_package_installed(adb_path, serial, FACEBOOK_PACKAGE)
            {
                log::info!("Facebook app installed on {} from URL APK", serial);
                return Ok(());
            }
        }
        Ok(None) => {}
        Err(e) => {
            log::warn!("Download Facebook APK from URL failed: {}", e);
        }
    }

    log::info!(
        "Facebook app still missing on {}, opening Play Store for auto-install",
        serial
    );
    let _ = run_adb_command(
        adb_path,
        Some(serial),
        &[
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            "market://details?id=com.facebook.katana",
        ],
    );

    tokio::time::sleep(tokio::time::Duration::from_secs(4)).await;

    let install_keywords = ["install", "installing", "update", "get", "ติดตั้ง", "อัปเดต"];

    for _ in 0..30 {
        if adb_is_package_installed(adb_path, serial, FACEBOOK_PACKAGE) {
            log::info!("Facebook app installed on {}", serial);
            return Ok(());
        }

        if let Ok(ui_xml) = adb_dump_ui_xml(adb_path, serial) {
            if let Some((x, y)) = find_node_center_with_keywords(&ui_xml, &install_keywords) {
                let _ = adb_tap(adb_path, serial, x, y);
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    }

    Err("Facebook app is not installed yet (Play Store may require sign-in).".to_string())
}

async fn wait_for_new_emulator_serial(
    adb_path: &Path,
    existing_serials: &HashSet<String>,
) -> Result<String, String> {
    let mut fallback: Option<String> = None;

    for _ in 0..45 {
        if let Ok(serials) = list_adb_emulator_serials(adb_path) {
            if let Some(serial) = serials
                .iter()
                .find(|serial| !existing_serials.contains(*serial))
            {
                return Ok(serial.clone());
            }

            if existing_serials.is_empty() && !serials.is_empty() {
                fallback = serials.last().cloned();
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    }

    fallback.ok_or("No Android emulator device appeared in adb".to_string())
}

async fn wait_android_boot_completed(adb_path: &Path, serial: &str) -> Result<(), String> {
    // Keep waiting even if adb returns temporary errors during boot.
    for _ in 0..120 {
        let boot = run_adb_command(
            adb_path,
            Some(serial),
            &["shell", "getprop", "sys.boot_completed"],
        )
        .unwrap_or_default();

        if boot.trim() == "1" {
            return Ok(());
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }

    Err(format!("Android emulator {} boot timeout", serial))
}

fn resolve_login_identifier(profile: &Profile) -> Option<String> {
    let uid = profile.uid.as_deref().unwrap_or("").trim();
    if !uid.is_empty() {
        return Some(uid.to_string());
    }

    let username = profile.username.as_deref().unwrap_or("").trim();
    if !username.is_empty() {
        return Some(username.to_string());
    }

    None
}

async fn autofill_android_facebook_login(
    profile_id: String,
    adb_path: PathBuf,
    existing_serials: Vec<String>,
    login_id: Option<String>,
    password: Option<String>,
    clear_facebook_first: bool,
) -> Result<(), String> {
    let before: HashSet<String> = existing_serials.into_iter().collect();
    let serial = wait_for_new_emulator_serial(&adb_path, &before).await?;
    log::info!(
        "Android auto-fill target device for profile {}: {}",
        profile_id,
        serial
    );

    wait_android_boot_completed(&adb_path, &serial).await?;
    let _ = run_adb_command(
        &adb_path,
        Some(&serial),
        &["shell", "input", "keyevent", "82"],
    );
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    if let Err(e) = ensure_facebook_app_installed(&adb_path, &serial).await {
        log::warn!(
            "Facebook auto-install did not complete for profile {}: {}",
            profile_id,
            e
        );
    }

    let _ = run_adb_command(
        &adb_path,
        Some(&serial),
        &[
            "shell",
            "monkey",
            "-p",
            "com.facebook.katana",
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
        ],
    );
    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

    if clear_facebook_first {
        let _ = run_adb_command(
            &adb_path,
            Some(&serial),
            &["shell", "pm", "clear", "com.facebook.katana"],
        );
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }

    let login_id = login_id.unwrap_or_default().trim().to_string();
    let password = password.unwrap_or_default().trim().to_string();
    if login_id.is_empty() || password.is_empty() {
        log::info!(
            "Android auto-fill skipped for profile {} (missing uid/username or password)",
            profile_id
        );
        return Ok(());
    }

    // Best effort: bring Facebook app to foreground so fields are predictable.
    let _ = run_adb_command(
        &adb_path,
        Some(&serial),
        &[
            "shell",
            "monkey",
            "-p",
            "com.facebook.katana",
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
        ],
    );
    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

    let screen = get_screen_size_from_adb(&adb_path, &serial).unwrap_or((1080, 2400));
    let fallback_user = (screen.0 / 2, (screen.1 as f32 * 0.46) as i32);
    let fallback_pass = (screen.0 / 2, (screen.1 as f32 * 0.56) as i32);

    for _ in 0..4 {
        let ui_xml = adb_dump_ui_xml(&adb_path, &serial).unwrap_or_default();

        let user_pos = find_node_center_with_keywords(
            &ui_xml,
            &[
                "mobile number or email",
                "phone number or email",
                "email or phone",
                "email address",
                "username",
                "login_username",
                "input_email",
            ],
        )
        .unwrap_or(fallback_user);

        let pass_pos = find_node_center_with_keywords(
            &ui_xml,
            &["password", "login_password", "input_password", "pass"],
        )
        .unwrap_or(fallback_pass);

        if adb_tap(&adb_path, &serial, user_pos.0, user_pos.1).is_ok() {
            tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;
            adb_clear_focused_input(&adb_path, &serial);
            let _ = adb_input_text(&adb_path, &serial, &login_id);
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;

        if adb_tap(&adb_path, &serial, pass_pos.0, pass_pos.1).is_ok() {
            tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;
            adb_clear_focused_input(&adb_path, &serial);
            let _ = adb_input_text(&adb_path, &serial, &password);
            log::info!("Android auto-fill completed for profile {}", profile_id);
            return Ok(());
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }

    Err("Unable to locate Facebook login fields for Android auto-fill".to_string())
}

fn find_matching_avd(available_avds: &[String], wanted_name: &str) -> Option<String> {
    let wanted = wanted_name.trim();
    if wanted.is_empty() {
        return None;
    }

    available_avds
        .iter()
        .find(|avd| avd.eq_ignore_ascii_case(wanted))
        .cloned()
}

fn extract_avd_hint_from_tags(profile: &Profile) -> Option<String> {
    let tags = profile.tags.as_ref()?;
    for tag in tags {
        let tag_trimmed = tag.trim();
        let tag_lower = tag_trimmed.to_ascii_lowercase();
        if tag_lower.starts_with("avd:") || tag_lower.starts_with("android-avd:") {
            if let Some((_, value)) = tag_trimmed.split_once(':') {
                let avd_name = value.trim();
                if !avd_name.is_empty() {
                    return Some(avd_name.to_string());
                }
            }
        }
    }
    None
}

fn extract_avd_hint_from_notes(profile: &Profile) -> Option<String> {
    for raw_line in profile.notes.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        let separator = if line.contains('=') { '=' } else { ':' };
        let Some((key, value)) = line.split_once(separator) else {
            continue;
        };

        let normalized_key = key.trim().to_ascii_lowercase();
        if normalized_key == "android_avd"
            || normalized_key == "android-avd"
            || normalized_key == "avd"
        {
            let avd_name = value.trim();
            if !avd_name.is_empty() {
                return Some(avd_name.to_string());
            }
        }
    }
    None
}

fn resolve_android_avd_for_profile(profile: &Profile, available_avds: &[String]) -> Option<String> {
    if let Ok(default_avd) = std::env::var(ANDROID_AVD_ENV_KEY) {
        if let Some(matched) = find_matching_avd(available_avds, &default_avd) {
            return Some(matched);
        }
    }

    if let Some(tag_hint) = extract_avd_hint_from_tags(profile) {
        if let Some(matched) = find_matching_avd(available_avds, &tag_hint) {
            return Some(matched);
        }
    }

    if let Some(note_hint) = extract_avd_hint_from_notes(profile) {
        if let Some(matched) = find_matching_avd(available_avds, &note_hint) {
            return Some(matched);
        }
    }

    if let Some(matched) = find_matching_avd(available_avds, &profile.name) {
        return Some(matched);
    }

    available_avds.first().cloned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AndroidProfileMeta {
    profile_avd_name: String,
    source_avd_name: Option<String>,
}

fn get_android_profiles_root_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("BrowserSaving")
        .join("android-profiles")
}

fn get_android_profile_dir(profile_id: &str) -> PathBuf {
    get_android_profiles_root_dir().join(profile_id)
}

fn get_android_profile_meta_path(profile_id: &str) -> PathBuf {
    get_android_profile_dir(profile_id).join(ANDROID_PROFILE_META_FILE)
}

fn sanitize_profile_avd_name(profile_id: &str) -> String {
    let compact: String = profile_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let suffix = if compact.is_empty() {
        "profile".to_string()
    } else {
        compact.chars().take(20).collect()
    };
    format!("bs_{}", suffix)
}

fn has_local_android_profile_data(profile_id: &str) -> bool {
    let profile_dir = get_android_profile_dir(profile_id);
    if !profile_dir.exists() {
        return false;
    }

    fs::read_dir(&profile_dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .any(|path| {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if file_name == ANDROID_PROFILE_META_FILE {
                return false;
            }
            if path.is_dir() {
                return true;
            }
            if path.is_file() {
                return file_name.ends_with(".img")
                    || file_name.ends_with(".qcow2")
                    || file_name.ends_with(".ini")
                    || file_name.ends_with(".bin");
            }
            false
        })
}

fn read_android_profile_meta(profile_id: &str) -> Option<AndroidProfileMeta> {
    let meta_path = get_android_profile_meta_path(profile_id);
    let content = fs::read_to_string(meta_path).ok()?;
    serde_json::from_str::<AndroidProfileMeta>(&content).ok()
}

fn write_android_profile_meta(profile_id: &str, meta: &AndroidProfileMeta) {
    let profile_dir = get_android_profile_dir(profile_id);
    if fs::create_dir_all(&profile_dir).is_err() {
        return;
    }
    let meta_path = profile_dir.join(ANDROID_PROFILE_META_FILE);
    if let Ok(content) = serde_json::to_string_pretty(meta) {
        let _ = fs::write(meta_path, content);
    }
}

fn resolve_local_profile_avd_name(profile_id: &str) -> Option<String> {
    let meta = read_android_profile_meta(profile_id)?;
    meta.source_avd_name.or(Some(meta.profile_avd_name))
}

fn get_android_avd_home_dirs() -> Vec<PathBuf> {
    let mut homes = Vec::new();

    if let Ok(avd_home) = std::env::var("ANDROID_AVD_HOME") {
        let trimmed = avd_home.trim();
        if !trimmed.is_empty() {
            homes.push(PathBuf::from(trimmed));
        }
    }

    if let Some(home_dir) = dirs::home_dir() {
        homes.push(home_dir.join(".android").join("avd"));
    }

    let mut unique = Vec::new();
    for path in homes {
        if !unique.iter().any(|existing: &PathBuf| existing == &path) {
            unique.push(path);
        }
    }
    unique
}

fn read_ini_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((lhs, rhs)) = trimmed.split_once('=') else {
            continue;
        };
        if lhs.trim().eq_ignore_ascii_case(key) {
            let value = rhs.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn resolve_source_avd_content_dir(avd_name: &str) -> Option<PathBuf> {
    for avd_home in get_android_avd_home_dirs() {
        let direct = avd_home.join(format!("{}.avd", avd_name));
        if direct.exists() {
            return Some(direct);
        }

        let ini_path = avd_home.join(format!("{}.ini", avd_name));
        let Ok(content) = fs::read_to_string(&ini_path) else {
            continue;
        };

        if let Some(path) = read_ini_value(&content, "path") {
            let absolute = PathBuf::from(path);
            if absolute.exists() {
                return Some(absolute);
            }
        }

        if let Some(path_rel) = read_ini_value(&content, "path.rel") {
            let base = avd_home.parent().unwrap_or(&avd_home);
            let resolved = base.join(path_rel);
            if resolved.exists() {
                return Some(resolved);
            }
        }
    }

    None
}

fn resolve_source_userdata_seed(avd_name: &str) -> Option<PathBuf> {
    let avd_content = resolve_source_avd_content_dir(avd_name)?;

    let candidates = [
        avd_content.join("userdata-qemu.img"),
        avd_content.join("userdata.img"),
    ];

    candidates.into_iter().find(|path| path.exists())
}

fn cleanup_android_artifacts_recursive(path: &Path) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            cleanup_android_artifacts_recursive(&entry_path);
            continue;
        }

        let file_name = entry_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();

        let is_transient = file_name.ends_with(".lock")
            || file_name == "cache.img"
            || file_name == "cache.img.qcow2"
            || file_name == "multiinstance.lock"
            || file_name == "hardware-qemu.ini.lock"
            || file_name == "read-snapshot.txt"
            || file_name == "emu-launch-params.txt"
            || file_name == "tmpAdbCmds";

        if is_transient {
            let _ = fs::remove_file(&entry_path);
        }
    }
}

fn get_android_sync_max_bytes() -> u64 {
    let mb = std::env::var("BROWSERSAVING_ANDROID_SYNC_MAX_MB")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(ANDROID_SYNC_MAX_MB_DEFAULT);
    mb * 1024 * 1024
}

fn dir_size_bytes(path: &Path) -> u64 {
    let mut total = 0_u64;
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total = total.saturating_add(meta.len());
            } else if meta.is_dir() {
                total = total.saturating_add(dir_size_bytes(&entry_path));
            }
        }
    }

    total
}

async fn ensure_android_profile_avd(
    profile: &Profile,
    emulator_path: &PathBuf,
) -> Result<String, String> {
    let profile_id = profile.id.clone();

    if let Err(e) = download_android_data(profile_id.clone()).await {
        log::warn!(
            "Android cloud restore failed for profile {} (will keep local datadir flow): {}",
            profile_id,
            e
        );
    }

    let available_avds = list_available_avds(emulator_path)?;
    if available_avds.is_empty() {
        return Err(
            "No source AVD found on this machine. Create one first in Android Studio or AvdBuddy."
                .to_string(),
        );
    }

    if let Some(local_source_avd) = resolve_local_profile_avd_name(&profile_id) {
        if let Some(matched) = find_matching_avd(&available_avds, &local_source_avd) {
            return Ok(matched);
        }
    }

    let source_avd_name = resolve_android_avd_for_profile(profile, &available_avds)
        .ok_or_else(|| "Cannot resolve source AVD for this profile".to_string())?;

    write_android_profile_meta(
        &profile.id,
        &AndroidProfileMeta {
            profile_avd_name: sanitize_profile_avd_name(&profile.id),
            source_avd_name: Some(source_avd_name.clone()),
        },
    );

    Ok(source_avd_name)
}

// CDP Log structures
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkLog {
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleLog {
    pub level: String,
    pub text: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CookieInfo {
    pub name: String,
    pub value: String,
    pub domain: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DebugLogs {
    pub network: Vec<NetworkLog>,
    pub console: Vec<ConsoleLog>,
    pub cookies: Vec<CookieInfo>,
}

// State to track running browsers
#[derive(Clone)]
pub struct AppState {
    running_browsers: Arc<Mutex<HashMap<String, u32>>>, // profile_id -> pid
    uploading_profiles: Arc<Mutex<Vec<String>>>,        // profiles currently uploading
    running_android_emulators: Arc<Mutex<HashMap<String, u32>>>, // profile_id -> pid
    uploading_android_profiles: Arc<Mutex<Vec<String>>>, // profiles currently uploading android data
    debug_ports: Arc<Mutex<HashMap<String, u16>>>,       // profile_id -> debug port
    debug_logs: Arc<Mutex<HashMap<String, DebugLogs>>>,  // profile_id -> logs
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            running_browsers: Arc::new(Mutex::new(HashMap::new())),
            uploading_profiles: Arc::new(Mutex::new(Vec::new())),
            running_android_emulators: Arc::new(Mutex::new(HashMap::new())),
            uploading_android_profiles: Arc::new(Mutex::new(Vec::new())),
            debug_ports: Arc::new(Mutex::new(HashMap::new())),
            debug_logs: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// Get cache directory for browser profiles
fn get_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("BrowserSaving")
        .join("profiles")
}

fn get_android_sync_download_url(profile_id: &str) -> String {
    format!(
        "{}/api/android-presigned/{}/download",
        get_server_url(),
        profile_id
    )
}

fn get_android_sync_upload_url(profile_id: &str) -> String {
    format!(
        "{}/api/android-presigned/{}/upload",
        get_server_url(),
        profile_id
    )
}

async fn download_android_data(profile_id: String) -> Result<bool, String> {
    if has_local_android_profile_data(&profile_id) {
        log::info!(
            "Using local Android cache for profile: {} (skip download)",
            profile_id
        );
        return Ok(true);
    }

    let endpoint = get_android_sync_download_url(&profile_id);
    let http_client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Create Android sync client failed: {}", e))?;

    let response = http_client
        .get(&endpoint)
        .send()
        .await
        .map_err(|e| format!("Get Android download URL failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Get Android download URL failed: HTTP {}",
            response.status()
        ));
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Parse Android download URL response failed: {}", e))?;

    let exists = payload
        .get("exists")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !exists {
        log::info!("No Android cloud data for profile: {}", profile_id);
        return Ok(false);
    }

    let signed_url = payload
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("Android download URL missing")?;

    let profile_dir = get_android_profile_dir(&profile_id);
    let temp_file = std::env::temp_dir().join(format!("android-{}-down.tar.gz", profile_id));
    log::info!("Downloading Android data for profile: {}", profile_id);

    let curl_status = Command::new("curl")
        .args([
            "-fL",
            "-sS",
            "--connect-timeout",
            "10",
            "--max-time",
            "45",
            "-o",
            temp_file.to_string_lossy().as_ref(),
            signed_url,
        ])
        .status()
        .map_err(|e| format!("Run curl download failed: {}", e))?;

    if !curl_status.success() {
        let _ = fs::remove_file(&temp_file);
        return Err(format!(
            "Download Android data failed (curl exit: {})",
            curl_status
        ));
    }

    if profile_dir.exists() {
        fs::remove_dir_all(&profile_dir)
            .map_err(|e| format!("Reset Android profile dir: {}", e))?;
    }
    fs::create_dir_all(&profile_dir).map_err(|e| format!("Create Android profile dir: {}", e))?;

    let archive_file = File::open(&temp_file)
        .map_err(|e| format!("Open downloaded Android archive failed: {}", e))?;
    let tar = flate2::read::GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(tar);
    archive
        .unpack(&profile_dir)
        .map_err(|e| format!("Extract Android archive failed: {}", e))?;

    let _ = fs::remove_file(&temp_file);
    log::info!("Android cloud data restored for profile: {}", profile_id);
    Ok(has_local_android_profile_data(&profile_id))
}

async fn upload_android_data(profile_id: String) -> Result<bool, String> {
    if !has_local_android_profile_data(&profile_id) {
        log::info!(
            "Skip Android upload (no local data) for profile: {}",
            profile_id
        );
        return Ok(false);
    }

    let profile_dir = get_android_profile_dir(&profile_id);
    cleanup_android_artifacts_recursive(&profile_dir);

    let profile_size_bytes = dir_size_bytes(&profile_dir);
    let max_sync_bytes = get_android_sync_max_bytes();
    if profile_size_bytes > max_sync_bytes {
        log::warn!(
            "Skip Android cloud sync for {}: profile size {:.2} MB exceeds limit {:.2} MB",
            profile_id,
            profile_size_bytes as f64 / 1024.0 / 1024.0,
            max_sync_bytes as f64 / 1024.0 / 1024.0
        );
        return Ok(false);
    }

    let temp_file = std::env::temp_dir().join(format!("android-{}-up.tar.gz", profile_id));
    let tar_gz =
        File::create(&temp_file).map_err(|e| format!("Create Android archive failed: {}", e))?;
    let encoder = flate2::write::GzEncoder::new(tar_gz, flate2::Compression::fast());
    let mut tar_builder = tar::Builder::new(encoder);
    tar_builder
        .append_dir_all(".", &profile_dir)
        .map_err(|e| format!("Pack Android profile data failed: {}", e))?;
    tar_builder
        .finish()
        .map_err(|e| format!("Finalize Android archive failed: {}", e))?;

    let size_bytes = fs::metadata(&temp_file).map(|meta| meta.len()).unwrap_or(0);
    log::info!(
        "Android archive ready for {} ({:.2} MB)",
        profile_id,
        size_bytes as f64 / 1024.0 / 1024.0
    );

    let upload_url_endpoint = get_android_sync_upload_url(&profile_id);
    let http_client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Create Android sync client failed: {}", e))?;

    let upload_res = http_client
        .get(&upload_url_endpoint)
        .send()
        .await
        .map_err(|e| format!("Get Android upload URL failed: {}", e))?;

    if !upload_res.status().is_success() {
        let _ = fs::remove_file(&temp_file);
        return Err(format!(
            "Get Android upload URL failed: HTTP {}",
            upload_res.status()
        ));
    }

    let upload_payload: serde_json::Value = upload_res
        .json()
        .await
        .map_err(|e| format!("Parse Android upload URL response failed: {}", e))?;

    let signed_url = upload_payload
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("Android upload URL missing")?;

    let curl_status = Command::new("curl")
        .args([
            "-f",
            "-sS",
            "--connect-timeout",
            "10",
            "--max-time",
            "45",
            "-X",
            "PUT",
            "-H",
            "Content-Type: application/gzip",
            "--upload-file",
            temp_file.to_string_lossy().as_ref(),
            signed_url,
        ])
        .status()
        .map_err(|e| format!("Run curl upload failed: {}", e))?;

    let _ = fs::remove_file(&temp_file);

    if !curl_status.success() {
        return Err(format!(
            "Upload Android data failed (curl exit: {})",
            curl_status
        ));
    }

    log::info!("Android data synced for profile: {}", profile_id);
    Ok(true)
}

// Get stealth extension directory
fn get_stealth_extension_dir() -> PathBuf {
    // First try resource dir (for bundled app)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(app_dir) = exe_path.parent() {
            // macOS: Contents/MacOS -> Contents/Resources
            let resources = app_dir
                .parent()
                .map(|p| p.join("Resources/stealth-extension"));
            if let Some(ext_path) = resources {
                if ext_path.exists() {
                    return ext_path;
                }
            }
        }
    }

    // Fallback for development
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/stealth-extension");
    if dev_path.exists() {
        return dev_path;
    }

    // Last resort: create in cache dir
    let cache_ext = dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("BrowserSaving")
        .join("stealth-extension");

    // Create extension if not exists - always recreate to ensure latest version
    fs::create_dir_all(&cache_ext).ok();

    let manifest = r#"{
  "name": "Stealth",
  "version": "2.0",
  "manifest_version": 3,
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["stealth.js"],
    "run_at": "document_start",
    "all_frames": true,
    "world": "MAIN"
  }]
}"#;
    fs::write(cache_ext.join("manifest.json"), manifest).ok();

    let stealth_js = r#"// === MINIMAL STEALTH - Only essential modifications ===

// 1. Hide webdriver property (most important)
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
try { delete Object.getPrototypeOf(navigator).webdriver; } catch(e) {}

// 2. Remove ChromeDriver detection variables
try {
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Object;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Proxy;
} catch(e) {}

// 3. Fix navigator.permissions.query for notifications (natural behavior)
const origQuery = window.Permissions?.prototype?.query;
if (origQuery) {
  window.Permissions.prototype.query = function(params) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission });
    }
    return origQuery.call(this, params);
  };
}

console.log('[Stealth v3] Minimal mode');"#;
    fs::write(cache_ext.join("stealth.js"), stealth_js).ok();

    cache_ext
}

// Get wrapper apps directory
fn get_wrapper_apps_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("BrowserSaving")
        .join("apps")
}

fn sanitize_wrapper_app_name(profile_name: &str) -> String {
    let mut normalized = String::new();
    for ch in profile_name.trim().chars() {
        if ch.is_control() || matches!(ch, '/' | '\\' | ':') {
            normalized.push('_');
        } else {
            normalized.push(ch);
        }
    }

    let collapsed = normalized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_matches('.')
        .trim()
        .to_string();

    if collapsed.is_empty() {
        "BrowserSaving Profile".to_string()
    } else {
        collapsed
    }
}

fn get_wrapper_profile_dir(profile_id: &str) -> PathBuf {
    get_wrapper_apps_dir().join(profile_id)
}

fn cleanup_wrapper_for_profile(profile_id: &str) {
    let profile_dir = get_wrapper_profile_dir(profile_id);
    if profile_dir.exists() {
        let _ = fs::remove_dir_all(&profile_dir);
    }

    // Backward compatibility: cleanup legacy wrapper at apps/{profile_id}.app
    let legacy_app_path = get_wrapper_apps_dir().join(format!("{}.app", profile_id));
    if legacy_app_path.exists() {
        let _ = fs::remove_dir_all(legacy_app_path);
    }
}

fn resolve_profile_avatar_url(profile: &Profile) -> Option<String> {
    let raw = profile.avatar_url.as_ref()?.trim();
    if raw.is_empty() {
        return None;
    }

    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Some(raw.to_string());
    }

    let server = get_server_url();
    if raw.starts_with('/') {
        Some(format!("{}{}", server, raw))
    } else {
        Some(format!("{}/{}", server.trim_end_matches('/'), raw))
    }
}

#[cfg(target_os = "macos")]
fn run_icon_command(command: &mut Command, step: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|e| format!("{} failed to start: {}", step, e))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!("{} failed with status {}", step, output.status))
    } else {
        Err(format!("{} failed: {}", step, stderr))
    }
}

#[cfg(target_os = "macos")]
fn create_profile_icon_icns(avatar_url: &str, resources_dir: &Path) -> Result<(), String> {
    let source_path = resources_dir.join("avatar-source");
    let iconset_dir = resources_dir.join("AppIcon.iconset");
    let icon_path = resources_dir.join("AppIcon.icns");

    if iconset_dir.exists() {
        let _ = fs::remove_dir_all(&iconset_dir);
    }
    let _ = fs::remove_file(&icon_path);

    fs::create_dir_all(&iconset_dir).map_err(|e| format!("Create iconset dir failed: {}", e))?;

    run_icon_command(
        Command::new("curl")
            .arg("-L")
            .arg("-f")
            .arg("-sS")
            .arg(avatar_url)
            .arg("-o")
            .arg(&source_path),
        "Download avatar",
    )?;

    let icon_sizes = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ];

    for (file_name, size) in icon_sizes {
        let mut sips_cmd = Command::new("sips");
        sips_cmd
            .arg("-s")
            .arg("format")
            .arg("png")
            .arg("--resampleHeightWidth")
            .arg(size.to_string())
            .arg(size.to_string())
            .arg(&source_path)
            .arg("--out")
            .arg(iconset_dir.join(file_name));
        run_icon_command(&mut sips_cmd, &format!("Generate {}", file_name))?;
    }

    run_icon_command(
        Command::new("iconutil")
            .arg("-c")
            .arg("icns")
            .arg(&iconset_dir)
            .arg("-o")
            .arg(&icon_path),
        "Build AppIcon.icns",
    )?;

    let _ = fs::remove_file(source_path);
    let _ = fs::remove_dir_all(iconset_dir);

    Ok(())
}

#[cfg(target_os = "macos")]
fn write_profile_wrapper_plist(
    plist_path: &Path,
    profile_name: &str,
    profile_id: &str,
) -> Result<(), String> {
    let safe_name = if profile_name.trim().is_empty() {
        "BrowserSaving Profile".to_string()
    } else {
        profile_name.trim().to_string()
    };
    let bundle_id = format!("com.browsersaving.profile.{}", profile_id);
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>ProfileChrome</string>
  <key>CFBundleIdentifier</key><string>{bundle_id}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>{safe_name}</string>
  <key>CFBundleDisplayName</key><string>{safe_name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"#
    );

    fs::write(plist_path, plist).map_err(|e| format!("Write wrapper Info.plist failed: {}", e))
}

fn get_profile_wrapper_exec(profile: &Profile, chrome_path: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let avatar_url = resolve_profile_avatar_url(profile)?;
        let profile_dir = get_wrapper_profile_dir(&profile.id);
        let app_name = sanitize_wrapper_app_name(&profile.name);
        let wrapper_app_path = profile_dir.join(format!("{}.app", app_name));
        let contents_dir = wrapper_app_path.join("Contents");
        let macos_dir = contents_dir.join("MacOS");
        let resources_dir = contents_dir.join("Resources");
        let wrapper_exec = macos_dir.join("ProfileChrome");

        if wrapper_exec.exists() {
            return Some(wrapper_exec);
        }

        if profile_dir.exists() {
            let _ = fs::remove_dir_all(&profile_dir);
        }
        let legacy_app_path = get_wrapper_apps_dir().join(format!("{}.app", profile.id));
        if legacy_app_path.exists() {
            let _ = fs::remove_dir_all(legacy_app_path);
        }

        if let Err(e) = fs::create_dir_all(&macos_dir) {
            log::warn!("Create wrapper MacOS dir failed: {}", e);
            return None;
        }
        if let Err(e) = fs::create_dir_all(&resources_dir) {
            log::warn!("Create wrapper Resources dir failed: {}", e);
            return None;
        }

        if let Err(e) = write_profile_wrapper_plist(
            &contents_dir.join("Info.plist"),
            &profile.name,
            &profile.id,
        ) {
            log::warn!("Create wrapper Info.plist failed: {}", e);
            let _ = fs::remove_dir_all(&wrapper_app_path);
            return None;
        }

        if let Err(e) = create_profile_icon_icns(&avatar_url, &resources_dir) {
            log::warn!("Create wrapper icon failed: {}", e);
            let _ = fs::remove_dir_all(&wrapper_app_path);
            return None;
        }

        if let Err(e) = symlink(chrome_path, &wrapper_exec) {
            log::warn!("Create wrapper executable symlink failed: {}", e);
            let _ = fs::remove_dir_all(&wrapper_app_path);
            return None;
        }

        Some(wrapper_exec)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = profile;
        let _ = chrome_path;
        None
    }
}

fn wrapper_app_path_from_exec(exec_path: &Path) -> Option<PathBuf> {
    let macos_dir = exec_path.parent()?;
    if macos_dir.file_name()?.to_string_lossy() != "MacOS" {
        return None;
    }

    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name()?.to_string_lossy() != "Contents" {
        return None;
    }

    let app_dir = contents_dir.parent()?;
    if app_dir.extension()?.to_string_lossy().to_lowercase() != "app" {
        return None;
    }

    Some(app_dir.to_path_buf())
}

fn spawn_chrome_process(
    launch_path: &Path,
    chrome_path: &Path,
    args: &[String],
) -> Result<Child, String> {
    #[cfg(target_os = "macos")]
    {
        if launch_path != chrome_path {
            if let Some(wrapper_app_path) = wrapper_app_path_from_exec(launch_path) {
                log::info!("Launching wrapper app: {}", wrapper_app_path.display());
                return Command::new("open")
                    .arg("-n")
                    .arg("-a")
                    .arg(&wrapper_app_path)
                    .arg("--args")
                    .args(args)
                    .spawn()
                    .map_err(|e| format!("Failed to launch wrapper app: {}", e));
            }
        }
    }

    Command::new(launch_path)
        .args(args)
        .spawn()
        .map_err(|e| format!("Failed to launch browser: {}", e))
}

// Get Chrome path - use Chrome for Testing
fn get_chrome_path() -> PathBuf {
    // Try newer version first
    let chrome_v144 = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cache/puppeteer/chrome/mac_arm-144.0.7559.96/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if chrome_v144.exists() {
        return chrome_v144;
    }

    // Fallback to older version
    let chrome_v127 = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cache/puppeteer/chrome/mac_arm-127.0.6533.88/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if chrome_v127.exists() {
        return chrome_v127;
    }

    // Last resort: regular Chrome
    PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
}

// Download browser data from server (via Worker CDN - faster than direct R2)
#[tauri::command]
async fn download_browser_data(profile_id: String) -> Result<bool, String> {
    let server_url = get_server_url();
    let cache_dir = get_cache_dir().join(&profile_id);
    let default_dir = cache_dir.join("Default");

    // FAST PATH: If local profile exists with data, skip download entirely
    if default_dir.exists() {
        let has_cookies = default_dir.join("Cookies").exists();
        let has_prefs = default_dir.join("Preferences").exists();

        if has_cookies || has_prefs {
            log::info!(
                "Using local cache for profile: {} (skip download)",
                profile_id
            );
            return Ok(true);
        }
    }

    log::info!("Downloading browser data for profile: {}", profile_id);
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let url = format!("{}/api/sync/{}/download", server_url, profile_id);
    log::info!("Download URL: {}", url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    match client.get(&url).send().await {
        Ok(response) => {
            if response.status() == 404 {
                log::info!("No existing data for profile: {}", profile_id);
                return Ok(true);
            }

            if !response.status().is_success() {
                log::warn!("Download failed: {}", response.status());
                return Ok(true);
            }

            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            let size_mb = bytes.len() as f64 / 1024.0 / 1024.0;
            log::info!("Downloaded {:.2} MB via CDN", size_mb);

            let temp_file = std::env::temp_dir().join(format!("browser-{}.tar.gz", profile_id));
            fs::write(&temp_file, &bytes).map_err(|e| e.to_string())?;

            // Clear and extract
            if cache_dir.exists() {
                fs::remove_dir_all(&cache_dir).ok();
            }
            fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

            let tar_gz = File::open(&temp_file).map_err(|e| e.to_string())?;
            let tar = flate2::read::GzDecoder::new(tar_gz);
            let mut archive = tar::Archive::new(tar);

            if let Err(e) = archive.unpack(&cache_dir) {
                log::warn!("Unpack warning: {}", e);
            }

            fs::remove_file(&temp_file).ok();
            log::info!("Browser data ready for: {}", profile_id);
            Ok(true)
        }
        Err(e) => {
            log::warn!("Download failed: {}", e);
            Ok(true)
        }
    }
}

// Upload browser data to server (via Worker CDN)
#[tauri::command]
async fn upload_browser_data(profile_id: String) -> Result<bool, String> {
    let server_url = get_server_url();
    let cache_dir = get_cache_dir().join(&profile_id);

    if !cache_dir.exists() {
        return Ok(false);
    }

    // Only sync essential files for login/session data (~1-2MB instead of 30MB)
    let essential_files = vec![
        "Default/Cookies",
        "Default/Cookies-wal",
        "Default/Cookies-shm",
        "Default/Cookies-journal",
        "Default/Login Data",
        "Default/Login Data-wal",
        "Default/Login Data-shm",
        "Default/Login Data-journal",
        "Default/Preferences",
        "Default/Secure Preferences",
        "Default/Web Data",
        "Default/Web Data-wal",
        "Default/Web Data-shm",
        "Default/Web Data-journal",
        "Default/Bookmarks",
        "Default/Favicons",
        "Default/History",
        "Default/History-wal",
        "Default/History-shm",
        "Default/History-journal",
        "Local State",
        "First Run",
        "cookies.json",
    ];

    let essential_dirs = vec![
        "Default/Local Storage",
        "Default/Session Storage",
        "Default/IndexedDB",
        "Default/Local Extension Settings",
        "Default/Extension State",
    ];

    // Create tar.gz with only essential files
    let temp_file = std::env::temp_dir().join(format!("browser-{}-up.tar.gz", profile_id));
    let tar_gz = File::create(&temp_file).map_err(|e| e.to_string())?;
    let enc = flate2::write::GzEncoder::new(tar_gz, flate2::Compression::fast());
    let mut tar_builder = tar::Builder::new(enc);

    // Add essential files
    for file_path in &essential_files {
        let full_path = cache_dir.join(file_path);
        if full_path.exists() && full_path.is_file() {
            tar_builder
                .append_path_with_name(&full_path, file_path)
                .ok();
        }
    }

    // Add essential directories
    for dir_path in &essential_dirs {
        let full_path = cache_dir.join(dir_path);
        if full_path.exists() && full_path.is_dir() {
            tar_builder.append_dir_all(dir_path, &full_path).ok();
        }
    }

    tar_builder.finish().map_err(|e| e.to_string())?;

    let mut file = File::open(&temp_file).map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).map_err(|e| e.to_string())?;

    let size_mb = buffer.len() as f64 / 1024.0 / 1024.0;
    log::info!("Uploading {} ({:.2} MB)", profile_id, size_mb);

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/api/sync/{}/upload", server_url, profile_id);

    let response = client
        .post(&url)
        .header("Content-Type", "application/gzip")
        .body(buffer)
        .send()
        .await;

    fs::remove_file(&temp_file).ok();

    match response {
        Ok(r) if r.status().is_success() => {
            log::info!("Uploaded successfully via CDN");
            log::info!("Upload complete for: {}", profile_id);
            Ok(true)
        }
        Ok(r) => {
            let status = r.status();
            log::warn!("Upload failed: {}, keeping local cache", status);
            Err(format!("Upload failed: HTTP {}", status))
        }
        Err(e) => {
            log::warn!("Upload error: {}, keeping local cache", e);
            Err(format!("Upload error: {}", e))
        }
    }
}

async fn upload_browser_data_with_retry(profile_id: &str) -> Result<bool, String> {
    let mut last_err: Option<String> = None;

    for attempt in 1..=3 {
        match upload_browser_data(profile_id.to_string()).await {
            Ok(result) => {
                if attempt > 1 {
                    log::info!(
                        "Upload succeeded for {} after {} attempt(s)",
                        profile_id,
                        attempt
                    );
                }
                return Ok(result);
            }
            Err(e) => {
                last_err = Some(e.clone());
                log::warn!(
                    "Upload attempt {} failed for {}: {}",
                    attempt,
                    profile_id,
                    e
                );

                if attempt < 3 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(600 * attempt as u64))
                        .await;
                }
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "Upload failed".to_string()))
}

// Export cookies from running browser via CDP
async fn export_cookies_via_cdp(port: u16, profile_id: &str) -> Result<usize, String> {
    use async_tungstenite::tokio::connect_async;
    use async_tungstenite::tungstenite::Message;
    use futures::SinkExt;
    use serde_json::json;

    // Use lightweight HTTP approach instead of Browser::connect to avoid UI flicker
    let client = reqwest::Client::new();

    // 1. Get WebSocket URL from CDP /json/version
    let version_url = format!("http://127.0.0.1:{}/json/version", port);
    let version_resp = client
        .get(&version_url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse version: {}", e))?;

    let ws_url = version_resp["webSocketDebuggerUrl"]
        .as_str()
        .ok_or("No WebSocket URL available")?;

    // 2. Connect to WebSocket and send Storage.getCookies
    let (mut ws_stream, _) = connect_async(ws_url)
        .await
        .map_err(|e| format!("WebSocket connect failed: {}", e))?;

    // Send Storage.getCookies command
    let cmd = json!({
        "id": 1,
        "method": "Storage.getCookies",
        "params": {}
    });

    ws_stream
        .send(Message::Text(cmd.to_string()))
        .await
        .map_err(|e| format!("Failed to send command: {}", e))?;

    // Receive response
    let mut cookies: Vec<serde_json::Value> = Vec::new();
    while let Some(msg) = ws_stream.next().await {
        if let Ok(Message::Text(text)) = msg {
            if let Ok(resp) = serde_json::from_str::<serde_json::Value>(&text) {
                if resp["id"] == 1 {
                    // Got our response
                    if let Some(cookies_arr) = resp["result"]["cookies"].as_array() {
                        cookies = cookies_arr.clone();
                    }
                    break;
                }
            }
        }
    }

    // Close WebSocket immediately
    let _ = ws_stream.close(None).await;

    let count = cookies.len();

    // Convert to Puppeteer/playwright format
    let formatted_cookies: Vec<serde_json::Value> = cookies
        .iter()
        .map(|c| {
            json!({
                "name": c["name"],
                "value": c["value"],
                "domain": c["domain"],
                "path": c["path"],
                "expires": c["expires"],
                "httpOnly": c["httpOnly"],
                "secure": c["secure"],
                "sameSite": c["sameSite"]
            })
        })
        .collect();

    // Serialize cookies to JSON
    let cookies_json = serde_json::to_string_pretty(&formatted_cookies)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    // Save to profile directory
    let cache_dir = get_cache_dir().join(profile_id);
    fs::create_dir_all(&cache_dir).ok();
    let cookies_path = cache_dir.join("cookies.json");
    fs::write(&cookies_path, &cookies_json).map_err(|e| format!("Failed to write: {}", e))?;

    log::info!(
        "Saved {} cookies to {} (no UI flicker)",
        count,
        cookies_path.display()
    );
    Ok(count)
}

fn extract_ea_token(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    let mut best = String::new();

    while i + 1 < chars.len() {
        if chars[i] == 'E' && chars[i + 1] == 'A' {
            let mut j = i;
            while j < chars.len() && chars[j].is_ascii_alphanumeric() {
                j += 1;
            }
            let candidate: String = chars[i..j].iter().collect();
            if candidate.len() > best.len() {
                best = candidate;
            }
            i = j;
        } else {
            i += 1;
        }
    }

    if best.len() >= 30 {
        Some(best)
    } else {
        None
    }
}

fn get_fb_token_cli_script_path() -> Option<PathBuf> {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/fb_token_cli.py");
    if dev_path.exists() {
        return Some(dev_path);
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(macos_dir) = exe_path.parent() {
            if let Some(contents_dir) = macos_dir.parent() {
                let packaged_candidates = [
                    contents_dir.join("Resources/fb_token_cli.py"),
                    contents_dir.join("Resources/resources/fb_token_cli.py"),
                ];
                for candidate in packaged_candidates {
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }
    }

    let external_fallbacks = [PathBuf::from("/Users/yok/Developer/token/to.py")];
    external_fallbacks
        .into_iter()
        .find(|candidate| candidate.exists())
}

fn get_python3_path() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("BROWSERSAVING_PYTHON3") {
        let path = PathBuf::from(explicit.trim());
        if path.exists() {
            return Some(path);
        }
    }

    let candidates = [
        PathBuf::from("/opt/homebrew/bin/python3"),
        PathBuf::from("/usr/local/bin/python3"),
        PathBuf::from("/usr/bin/python3"),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if let Ok(output) = Command::new("/usr/bin/which").arg("python3").output() {
        if output.status.success() {
            let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !resolved.is_empty() {
                let path = PathBuf::from(resolved);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }

    None
}

#[derive(Debug, Clone, Deserialize)]
struct LocalFacebookPictureData {
    url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct LocalFacebookPicture {
    data: Option<LocalFacebookPictureData>,
}

#[derive(Debug, Clone, Deserialize)]
struct LocalFacebookAccountItem {
    id: Option<String>,
    name: Option<String>,
    access_token: Option<String>,
    picture: Option<LocalFacebookPicture>,
}

fn normalize_page_name_local(raw: &str) -> String {
    raw.trim().to_lowercase()
}

fn parse_page_id_from_avatar_url_local(raw: &str) -> String {
    let input = raw.trim();
    if input.is_empty() {
        return String::new();
    }

    if let Some(idx) = input.find("/page-avatars/") {
        let tail = &input[idx + "/page-avatars/".len()..];
        let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            return digits;
        }
    }

    if let Some(idx) = input.find("graph.facebook.com/") {
        let tail = &input[idx + "graph.facebook.com/".len()..];
        let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            return digits;
        }
    }

    String::new()
}

fn pick_target_facebook_page_local(
    accounts: &[LocalFacebookAccountItem],
    profile_name: &str,
    stored_page_name: Option<&str>,
    stored_page_avatar_url: Option<&str>,
) -> Option<LocalFacebookAccountItem> {
    if accounts.is_empty() {
        return None;
    }

    let profile_name_hint = normalize_page_name_local(profile_name);
    let stored_page_name_hint = normalize_page_name_local(stored_page_name.unwrap_or_default());
    let has_explicit_page_hint =
        !stored_page_name_hint.is_empty() && stored_page_name_hint != profile_name_hint;

    if has_explicit_page_hint {
        let page_id_hint =
            parse_page_id_from_avatar_url_local(stored_page_avatar_url.unwrap_or_default());
        if !page_id_hint.is_empty() {
            if let Some(found) = accounts
                .iter()
                .find(|acc| acc.id.as_deref().unwrap_or_default().trim() == page_id_hint)
            {
                return Some(found.clone());
            }
        }

        if let Some(found) = accounts.iter().find(|acc| {
            normalize_page_name_local(acc.name.as_deref().unwrap_or_default())
                == stored_page_name_hint
        }) {
            return Some(found.clone());
        }
    }

    if !profile_name_hint.is_empty() {
        if let Some(found) = accounts.iter().find(|acc| {
            normalize_page_name_local(acc.name.as_deref().unwrap_or_default()) != profile_name_hint
        }) {
            return Some(found.clone());
        }
    }

    accounts.first().cloned()
}

#[tauri::command]
async fn resolve_page_token_via_graph(
    user_token: String,
    profile_name: String,
    page_name: Option<String>,
    page_avatar_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let token = user_token.trim().to_string();
    if token.is_empty() {
        return Err("Missing user token".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = client
        .get("https://graph.facebook.com/v21.0/me/accounts")
        .query(&[
            ("fields", "id,name,access_token,picture.type(large)"),
            ("limit", "200"),
            ("access_token", token.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Graph request failed: {}", e))?;

    let status = response.status();
    let raw: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid Graph response: {}", e))?;

    if !status.is_success() {
        let message = raw
            .get("error")
            .and_then(|err| err.get("message"))
            .and_then(|value| value.as_str())
            .unwrap_or("Facebook API failed");
        return Err(format!("facebook_me_accounts_failed: {}", message));
    }

    let accounts: Vec<LocalFacebookAccountItem> =
        serde_json::from_value(raw.get("data").cloned().unwrap_or(serde_json::Value::Null))
            .unwrap_or_default();

    if accounts.is_empty() {
        return Err("facebook_me_accounts_empty".to_string());
    }

    let matched = pick_target_facebook_page_local(
        &accounts,
        &profile_name,
        page_name.as_deref(),
        page_avatar_url.as_deref(),
    )
    .ok_or("facebook_me_accounts_ambiguous_profile_page_not_matched".to_string())?;

    let page_token = matched
        .access_token
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    if page_token.is_empty() {
        return Err("page_token_missing".to_string());
    }

    Ok(serde_json::json!({
        "pageToken": page_token,
        "pageId": matched.id.as_deref().unwrap_or_default().trim(),
        "pageName": matched.name.as_deref().unwrap_or_default().trim(),
        "pageAvatarUrl": matched
            .picture
            .as_ref()
            .and_then(|picture| picture.data.as_ref())
            .and_then(|data| data.url.as_deref())
            .unwrap_or_default()
            .trim(),
    }))
}

// Get local FB Lite token via Python CLI script
fn run_fb_token_cli_attempt(
    python_path: &Path,
    script_path: &Path,
    login: &str,
    password: &str,
    totp_secret: &str,
    datr: &str,
) -> Result<String, String> {
    let mut child = Command::new(python_path)
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to start python3 at {}: {}",
                python_path.display(),
                e
            )
        })?;

    let input_payload = format!("{}\n{}\n{}\n{}\n", login, password, totp_secret, datr);

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(input_payload.as_bytes())
            .map_err(|e| format!("Failed to write stdin: {}", e))?;
    } else {
        return Err("Failed to open stdin for python process".to_string());
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for python process: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{}\n{}", stdout, stderr);

    if let Some(token) = extract_ea_token(&combined) {
        return Ok(token);
    }

    let short_out = combined.lines().take(20).collect::<Vec<_>>().join("\n");
    Err(format!(
        "Script returned no token (exit: {}). Output:\n{}",
        output.status, short_out
    ))
}

#[tauri::command]
async fn get_comment_token_via_script(
    uid: Option<String>,
    username: Option<String>,
    password: Option<String>,
    totp_secret: Option<String>,
    datr: Option<String>,
) -> Result<String, String> {
    let mut login_candidates: Vec<String> = Vec::new();
    if let Some(value) = username.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        login_candidates.push(value.to_string());
    }
    if let Some(value) = uid.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !login_candidates.iter().any(|candidate| candidate == value) {
            login_candidates.push(value.to_string());
        }
    }
    if login_candidates.is_empty() {
        return Err("Missing UID/username".to_string());
    }

    let pass = password
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .ok_or("Missing password".to_string())?;
    let normalized_totp = totp_secret.unwrap_or_default().replace(' ', "");
    let normalized_datr = datr.unwrap_or_default().trim().to_string();

    let script_path = get_fb_token_cli_script_path().ok_or(
        "Local token CLI script not found. Expected fb_token_cli.py in app resources or /Users/yok/Developer/token/to.py"
            .to_string(),
    )?;
    let python_path = get_python3_path().ok_or(
        "python3 not found. Set BROWSERSAVING_PYTHON3 or install python3 in /opt/homebrew/bin, /usr/local/bin, or /usr/bin"
            .to_string(),
    )?;

    let mut attempt_errors: Vec<String> = Vec::new();

    for login in login_candidates {
        log::info!(
            "[Comment Token] Running script for login: {} via {} (datr: {})",
            login,
            python_path.display(),
            if normalized_datr.is_empty() {
                "no"
            } else {
                "yes"
            }
        );

        match run_fb_token_cli_attempt(
            &python_path,
            &script_path,
            &login,
            &pass,
            &normalized_totp,
            &normalized_datr,
        ) {
            Ok(token) => {
                log::info!("[Comment Token] Token extracted ({} chars)", token.len());
                return Ok(token);
            }
            Err(err) => {
                log::warn!("[Comment Token] Attempt failed for {}: {}", login, err);
                attempt_errors.push(format!("{} -> {}", login, err));
            }
        }
    }

    Err(format!(
        "Local token CLI failed for all login candidates:\n{}",
        attempt_errors.join("\n\n")
    ))
}

// Get Facebook token via browser automation
#[tauri::command]
async fn get_facebook_token(profile_id: String) -> Result<String, String> {
    use chromiumoxide::{Browser, BrowserConfig};

    log::info!("Getting Facebook token for profile: {}", profile_id);

    let cache_dir = get_cache_dir().join(&profile_id);
    if !cache_dir.exists() {
        return Err(
            "Profile not found. Please launch the browser first to create cookies.".to_string(),
        );
    }

    let chrome_path = get_chrome_path();
    let config = BrowserConfig::builder()
        .chrome_executable(&chrome_path)
        .arg(format!("--user-data-dir={}", cache_dir.display()))
        .arg("--no-first-run")
        .arg("--disable-infobars")
        .arg("--disable-blink-features=AutomationControlled")
        .arg("--password-store=basic")
        .arg("--use-mock-keychain")
        .arg("--window-size=900,700")
        .arg("--window-position=120,100")
        .with_head()
        .build()
        .map_err(|e| format!("Failed to build browser config: {}", e))?;

    let (mut browser, mut handler) = Browser::launch(config)
        .await
        .map_err(|e| format!("Failed to launch browser: {}", e))?;

    tokio::spawn(async move { while let Some(_) = handler.next().await {} });

    // Postcron OAuth URL (returns access_token in callback URL fragment)
    let oauth_url = "https://www.facebook.com/v18.0/dialog/oauth?client_id=350172498359498&redirect_uri=https://postcron.com/auth/login/facebook/callback&scope=pages_manage_posts,pages_read_engagement,pages_show_list,public_profile&response_type=token";

    let page = browser
        .new_page(oauth_url)
        .await
        .map_err(|e| format!("Failed to create page: {}", e))?;

    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

    let mut token = String::new();
    let mut last_url = String::new();

    for attempt in 0..90 {
        if let Ok(url) = page.url().await {
            if let Some(url_str) = url {
                if url_str != last_url {
                    log::info!(
                        "[Token Attempt {}] URL: {}",
                        attempt,
                        &url_str[..120.min(url_str.len())]
                    );
                    last_url = url_str.clone();
                }

                // Success case: access_token in callback URL
                if url_str.contains("access_token=") {
                    if let Some(fragment) = url_str.split('#').nth(1) {
                        for param in fragment.split('&') {
                            if param.starts_with("access_token=") {
                                token = param.replace("access_token=", "");
                                break;
                            }
                        }
                    }
                    if !token.is_empty() {
                        break;
                    }
                }

                if url_str.contains("error=") || url_str.contains("error_code=") {
                    let _ = browser.close().await;
                    return Err("Facebook OAuth was denied or failed.".to_string());
                }

                // Auto-click common continue buttons (Thai/English)
                let _ = page.evaluate(r#"
                    (() => {
                      const selectors = [
                        'button[name="__CONFIRM__"]',
                        'div[role="button"][aria-label*="Continue"]',
                        'div[role="button"][aria-label*="ดำเนินการต่อ"]',
                        'div[role="button"][aria-label*="ตกลง"]',
                        'button[type="submit"]'
                      ];
                      for (const s of selectors) {
                        const el = document.querySelector(s);
                        if (el) { el.click(); return true; }
                      }
                      const spans = Array.from(document.querySelectorAll('span'));
                      const match = spans.find((sp) => {
                        const t = (sp.textContent || '').trim();
                        return t.includes('Continue') || t.includes('ดำเนินการต่อ') || t.includes('ตกลง');
                      });
                      if (match) {
                        const btn = match.closest('[role=\"button\"],button');
                        if (btn) { btn.click(); return true; }
                      }
                      return false;
                    })()
                "#).await;
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(700)).await;
    }

    let _ = browser.close().await;

    if token.is_empty() {
        return Err(
            "Timeout: Could not get token. Open profile, ensure Facebook is logged in, then retry."
                .to_string(),
        );
    }

    log::info!("Got Facebook token: {}...", &token[..20.min(token.len())]);
    Ok(token)
}

// === POSTCRON STEP-BY-STEP TOKEN EXTRACTION ===
// Store browser session for step-by-step flow
use chromiumoxide::Page;
use std::sync::OnceLock;

struct PostcronSession {
    page: Page,
    _browser: chromiumoxide::Browser,
    chrome_pid: u32,
}

// Global session store (one at a time)
static POSTCRON_SESSION: OnceLock<tokio::sync::Mutex<Option<PostcronSession>>> = OnceLock::new();

fn get_postcron_session() -> &'static tokio::sync::Mutex<Option<PostcronSession>> {
    POSTCRON_SESSION.get_or_init(|| tokio::sync::Mutex::new(None))
}

// Step 1: Download profile + Export cookies locally + Connect Browserless + Inject
#[tauri::command]
async fn postcron_step_launch(profile_id: String) -> Result<String, String> {
    use chromiumoxide::cdp::browser_protocol::network::CookieParam;
    use chromiumoxide::Browser;

    log::info!("[Postcron Step 1] Starting for: {}", profile_id);

    // Clean up any previous session
    {
        let mut session = get_postcron_session().lock().await;
        if let Some(ref sess) = *session {
            if sess.chrome_pid > 0 {
                let _ = Command::new("kill")
                    .args(["-9", &sess.chrome_pid.to_string()])
                    .output();
            }
        }
        *session = None;
    }

    let cache_dir = get_cache_dir().join(&profile_id);
    let cookies_path = cache_dir.join("cookies.json");

    // === PHASE 1: Get cookies.json ===
    if !cookies_path.exists() {
        log::info!("[Postcron] No local cookies.json, downloading from R2...");
        fs::create_dir_all(&cache_dir).ok();

        let server_url = get_server_url();
        let url = format!("{}/api/sync/{}/download", server_url, profile_id);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("{}", e))?;

        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Download: {}", e))?;
        if !response.status().is_success() {
            return Err(format!(
                "Download failed: {}. Try: Launch browser → login Facebook → Stop first",
                response.status()
            ));
        }
        let bytes = response.bytes().await.map_err(|e| format!("{}", e))?;
        log::info!(
            "[Postcron] Downloaded {:.2} MB from R2",
            bytes.len() as f64 / 1024.0 / 1024.0
        );

        let temp_tar = std::env::temp_dir().join(format!("pc-{}.tar.gz", &profile_id[..8]));
        fs::write(&temp_tar, &bytes).map_err(|e| format!("{}", e))?;
        let tar_gz = File::open(&temp_tar).map_err(|e| format!("{}", e))?;
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tar_gz));

        let mut found_cookies = false;
        for entry in archive
            .entries()
            .map_err(|e| format!("Archive read: {}", e))?
        {
            if let Ok(mut entry) = entry {
                let path = entry.path().ok().map(|p| p.to_string_lossy().to_string());
                if let Some(ref p) = path {
                    if p == "cookies.json" || p.ends_with("/cookies.json") {
                        use std::io::Read;
                        let mut content = String::new();
                        entry.read_to_string(&mut content).ok();
                        if !content.is_empty() {
                            fs::write(&cookies_path, &content).ok();
                            found_cookies = true;
                            log::info!(
                                "[Postcron] Extracted cookies.json from R2 archive ({} bytes)",
                                content.len()
                            );
                        }
                        break;
                    }
                }
            }
        }
        fs::remove_file(&temp_tar).ok();

        if !found_cookies {
            return Err(
                "No cookies.json in R2 archive. Try: Launch browser → login Facebook → Stop first"
                    .to_string(),
            );
        }
    } else {
        log::info!("[Postcron] Using existing local cookies.json");
    }

    // === PHASE 2: Read cookies.json ===
    if !cookies_path.exists() {
        return Err(
            "Failed to export cookies. Try: Launch browser → browse Facebook → Stop".to_string(),
        );
    }

    let cookies_json =
        fs::read_to_string(&cookies_path).map_err(|e| format!("Read cookies.json: {}", e))?;
    let cookies: Vec<serde_json::Value> =
        serde_json::from_str(&cookies_json).map_err(|e| format!("Parse cookies.json: {}", e))?;
    let cookie_count = cookies.len();
    log::info!("[Postcron] Loaded {} cookies", cookie_count);

    // === PHASE 3: Connect to Browserless ===
    let browserless_token = "77482ddfd0ec44d1c1a8b55ddf352d98";
    let browserless_host = "browserless.lslly.com";

    let ws_url = format!("wss://{}/?token={}", browserless_host, browserless_token);
    log::info!("[Postcron] Connecting to Browserless: {}", ws_url);

    let (browser, mut handler) = Browser::connect(&ws_url)
        .await
        .map_err(|e| format!("Browserless connect: {}", e))?;

    tokio::spawn(async move { while let Some(_) = handler.next().await {} });

    let page = browser
        .new_page("about:blank")
        .await
        .map_err(|e| format!("New page: {}", e))?;

    // === PHASE 4: Inject cookies ===
    let mut injected = 0;
    for cookie in &cookies {
        let name = cookie.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let value = cookie.get("value").and_then(|v| v.as_str()).unwrap_or("");
        let domain = cookie.get("domain").and_then(|v| v.as_str()).unwrap_or("");
        let path = cookie.get("path").and_then(|v| v.as_str()).unwrap_or("/");
        let secure = cookie
            .get("secure")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let http_only = cookie
            .get("httpOnly")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if name.is_empty() || domain.is_empty() {
            continue;
        }

        let cookie_param = match CookieParam::builder()
            .name(name)
            .value(value)
            .domain(domain)
            .path(path)
            .secure(secure)
            .http_only(http_only)
            .build()
        {
            Ok(mut cp) => {
                if let Some(ss) = cookie.get("sameSite").and_then(|v| v.as_str()) {
                    cp.same_site = match ss {
                        "Strict" => Some(
                            chromiumoxide::cdp::browser_protocol::network::CookieSameSite::Strict,
                        ),
                        "Lax" => {
                            Some(chromiumoxide::cdp::browser_protocol::network::CookieSameSite::Lax)
                        }
                        "None" => Some(
                            chromiumoxide::cdp::browser_protocol::network::CookieSameSite::None,
                        ),
                        _ => None,
                    };
                }
                cp
            }
            Err(_) => continue,
        };

        let set_cmd =
            match chromiumoxide::cdp::browser_protocol::network::SetCookiesParams::builder()
                .cookie(cookie_param)
                .build()
            {
                Ok(cmd) => cmd,
                Err(_) => continue,
            };

        if page.execute(set_cmd).await.is_ok() {
            injected += 1;
        }
    }

    log::info!(
        "[Postcron] Injected {}/{} cookies into Browserless",
        injected,
        cookie_count
    );

    // Store session
    let mut session = get_postcron_session().lock().await;
    *session = Some(PostcronSession {
        page,
        _browser: browser,
        chrome_pid: 0,
    });

    Ok(format!(
        "Browserless ready. {}/{} cookies injected.",
        injected, cookie_count
    ))
}

// Step 1 (HEADFUL): Launch local Chrome with UI for debugging
#[tauri::command]
async fn postcron_step_launch_headful(profile_id: String) -> Result<String, String> {
    use chromiumoxide::cdp::browser_protocol::network::CookieParam;
    use chromiumoxide::Browser;

    log::info!("[Postcron Headful] Starting for: {}", profile_id);

    // Clean up
    {
        let mut session = get_postcron_session().lock().await;
        if let Some(ref sess) = *session {
            if sess.chrome_pid > 0 {
                let _ = Command::new("kill")
                    .args(["-9", &sess.chrome_pid.to_string()])
                    .output();
            }
        }
        *session = None;
    }

    let cache_dir = get_cache_dir().join(&profile_id);
    let cookies_path = cache_dir.join("cookies.json");

    // Get cookies
    if !cookies_path.exists() {
        return Err(
            "No cookies.json. Try: Launch browser → login Facebook → Stop first".to_string(),
        );
    }

    let cookies_json =
        fs::read_to_string(&cookies_path).map_err(|e| format!("Read cookies: {}", e))?;
    let cookies: Vec<serde_json::Value> =
        serde_json::from_str(&cookies_json).map_err(|e| format!("Parse cookies: {}", e))?;

    // Launch local Chrome with UI
    let chrome_path = get_chrome_path();
    let debug_port: u16 = 9222;

    let args = vec![
        format!("--remote-debugging-port={}", debug_port),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-infobars".to_string(),
        "--window-size=1280,800".to_string(),
    ];

    log::info!("[Postcron Headful] Launching Chrome: {:?}", chrome_path);

    let child = Command::new(&chrome_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Launch Chrome: {}", e))?;

    let chrome_pid = child.id();
    log::info!("[Postcron Headful] Chrome PID: {}", chrome_pid);

    // Wait for Chrome to start
    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

    // Connect via CDP
    let ws_url = format!("http://127.0.0.1:{}", debug_port);
    let (browser, mut handler) = Browser::connect(&ws_url)
        .await
        .map_err(|e| format!("Connect to Chrome: {}", e))?;

    tokio::spawn(async move { while let Some(_) = handler.next().await {} });

    let page = browser
        .new_page("about:blank")
        .await
        .map_err(|e| format!("New page: {}", e))?;

    // Inject cookies
    let mut injected = 0;
    for cookie in &cookies {
        let name = cookie.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let value = cookie.get("value").and_then(|v| v.as_str()).unwrap_or("");
        let domain = cookie.get("domain").and_then(|v| v.as_str()).unwrap_or("");
        let path = cookie.get("path").and_then(|v| v.as_str()).unwrap_or("/");
        let secure = cookie
            .get("secure")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let http_only = cookie
            .get("httpOnly")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if name.is_empty() || domain.is_empty() {
            continue;
        }

        if let Ok(cookie_param) = CookieParam::builder()
            .name(name)
            .value(value)
            .domain(domain)
            .path(path)
            .secure(secure)
            .http_only(http_only)
            .build()
        {
            if let Ok(cmd) =
                chromiumoxide::cdp::browser_protocol::network::SetCookiesParams::builder()
                    .cookie(cookie_param)
                    .build()
            {
                if page.execute(cmd).await.is_ok() {
                    injected += 1;
                }
            }
        }
    }

    log::info!(
        "[Postcron Headful] Injected {}/{} cookies",
        injected,
        cookies.len()
    );

    // Store session with PID
    let mut session = get_postcron_session().lock().await;
    *session = Some(PostcronSession {
        page,
        _browser: browser,
        chrome_pid,
    });

    Ok(format!(
        "Chrome opened! PID:{}. {}/{} cookies injected.",
        chrome_pid,
        injected,
        cookies.len()
    ))
}

// Step 2: Navigate to Postcron OAuth URL
#[tauri::command]
async fn postcron_step_navigate() -> Result<String, String> {
    let mut session = get_postcron_session().lock().await;
    let sess = session
        .as_mut()
        .ok_or("No browser session. Run Step 1 first.")?;

    let oauth_url = "https://postcron.com/api/v2.0/social-accounts/url-redirect/?should_redirect=true&social_network=facebook";

    log::info!("[Postcron Step 2] Navigating to: {}", oauth_url);

    sess.page
        .goto(oauth_url)
        .await
        .map_err(|e| format!("Failed to navigate: {}", e))?;

    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

    let url = sess
        .page
        .url()
        .await
        .map_err(|e| format!("Failed to get URL: {}", e))?
        .unwrap_or_default();

    log::info!(
        "[Postcron Step 2] Current URL: {}",
        &url[..150.min(url.len())]
    );
    Ok(format!("Current URL: {}", &url[..200.min(url.len())]))
}

// Step 3: Try to click "Continue" button
#[tauri::command]
async fn postcron_step_click() -> Result<String, String> {
    let mut session = get_postcron_session().lock().await;
    let sess = session
        .as_mut()
        .ok_or("No browser session. Run Step 1 first.")?;

    log::info!("[Postcron Step 3] Trying to click Continue button...");

    let click_result = sess.page.evaluate(r#"
        (function() {
            const selectors = [
                'button[name="__CONFIRM__"]',
                'div[aria-label*="ดำเนินการต่อ"]',
                'div[aria-label*="Continue"]',
            ];
            for (const selector of selectors) {
                try {
                    const btn = document.querySelector(selector);
                    if (btn) { btn.click(); return 'clicked: ' + selector; }
                } catch(e) {}
            }
            const xpath = "//div[@role='button']//span[contains(text(),'ดำเนินการต่อ') or contains(text(),'Continue')]";
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue) {
                const btn = result.singleNodeValue.closest('[role="button"]');
                if (btn) { btn.click(); return 'clicked xpath: ' + result.singleNodeValue.textContent.trim().slice(0, 50); }
            }
            const accountLink = document.querySelector('a[href*="profile.php"]');
            if (accountLink) { accountLink.click(); return 'clicked account link'; }
            return 'no_button';
        })()
    "#).await.map_err(|e| format!("Failed to evaluate: {}", e))?;

    let result_text = click_result
        .into_value::<String>()
        .unwrap_or_else(|_| "unknown".to_string());
    log::info!("[Postcron Step 3] Click: {}", result_text);

    // Wait for navigation
    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

    // Check if we need more clicks (e.g. privacy/consent page after forced_account_switch)
    let url = sess
        .page
        .url()
        .await
        .map_err(|e| format!("{}", e))?
        .unwrap_or_default();
    log::info!(
        "[Postcron Step 3] URL after first click: {}",
        &url[..150.min(url.len())]
    );

    // If still on Facebook (not yet redirected to postcron), try more clicks
    if !url.contains("access_token=") && !url.contains("postcron.com") {
        // Loop up to 10 times (30 sec total) to handle multi-page flows
        for attempt in 0..10 {
            log::info!(
                "[Postcron Step 3] Attempt {} - URL: {}",
                attempt + 2,
                &url[..100.min(url.len())]
            );

            // If on forced_account_switch, navigate to OAuth again
            if url.contains("forced_account_switch") {
                let oauth_url = "https://postcron.com/api/v2.0/social-accounts/url-redirect/?should_redirect=true&social_network=facebook";
                sess.page
                    .goto(oauth_url)
                    .await
                    .map_err(|e| format!("{}", e))?;
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }

            // Try clicking buttons again
            let click2 = sess.page.evaluate(r#"
                (function() {
                    // Try standard buttons
                    const selectors = ['button[name="__CONFIRM__"]', 'div[aria-label*="ดำเนินการต่อ"]', 'div[aria-label*="Continue"]'];
                    for (const s of selectors) {
                        const btn = document.querySelector(s);
                        if (btn) { btn.click(); return 'clicked: ' + s; }
                    }
                    // XPath
                    const xpath = "//div[@role='button']//span[contains(text(),'ดำเนินการต่อ') or contains(text(),'Continue')]";
                    const res = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    if (res.singleNodeValue) {
                        const btn = res.singleNodeValue.closest('[role="button"]');
                        if (btn) { btn.click(); return 'clicked xpath: ' + res.singleNodeValue.textContent.trim().slice(0, 50); }
                    }
                    return 'no_button';
                })()
            "#).await;

            if let Ok(r) = click2 {
                let txt = r.into_value::<String>().unwrap_or_default();
                log::info!("[Postcron Step 3] Click attempt {}: {}", attempt + 2, txt);
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

            let new_url = sess
                .page
                .url()
                .await
                .map_err(|e| format!("{}", e))?
                .unwrap_or_default();
            if new_url.contains("access_token=") || new_url.contains("postcron.com") {
                log::info!(
                    "[Postcron Step 3] Success! Redirected to: {}",
                    &new_url[..150.min(new_url.len())]
                );
                return Ok(format!("Done - redirected to postcron callback"));
            }
        }
    }

    let final_url = sess
        .page
        .url()
        .await
        .map_err(|e| format!("{}", e))?
        .unwrap_or_default();
    Ok(format!(
        "{}\n\nURL: {}",
        result_text,
        &final_url[..200.min(final_url.len())]
    ))
}

// Step 4: Extract token from URL + Close browser
#[tauri::command]
async fn postcron_step_extract() -> Result<serde_json::Value, String> {
    let mut session = get_postcron_session().lock().await;
    let sess = session.as_mut().ok_or("No browser session.")?;

    // Use JavaScript to extract token directly from browser
    log::info!("[Postcron Step 4] Using JavaScript to extract token from URL...");

    let js_result = sess.page.evaluate(r#"
        (function() {
            const url = window.location.href;
            console.log('[Postcron Extract] Current URL:', url);
            
            // Check for access_token in fragment
            if (url.includes('access_token=')) {
                const hashIndex = url.indexOf('#');
                if (hashIndex !== -1) {
                    const fragment = url.substring(hashIndex + 1);
                    const params = new URLSearchParams(fragment);
                    const token = params.get('access_token');
                    if (token) {
                        console.log('[Postcron Extract] Found token in fragment:', token.substring(0, 20) + '...');
                        return { success: true, token: token, source: 'fragment', url: url };
                    }
                }
                
                // Check query params
                const queryIndex = url.indexOf('?');
                if (queryIndex !== -1) {
                    const query = url.substring(queryIndex + 1, hashIndex !== -1 ? hashIndex : undefined);
                    const params = new URLSearchParams(query);
                    const token = params.get('access_token');
                    if (token) {
                        console.log('[Postcron Extract] Found token in query:', token.substring(0, 20) + '...');
                        return { success: true, token: token, source: 'query', url: url };
                    }
                }
            }
            
            return { success: false, url: url, error: 'No access_token found' };
        })()
    "#).await;

    match js_result {
        Ok(eval_result) => {
            match eval_result.into_value::<serde_json::Value>() {
                Ok(result_obj) => {
                    log::info!("[Postcron Step 4] JS result: {:?}", result_obj);

                    if let Some(token) = result_obj.get("token").and_then(|t| t.as_str()) {
                        if !token.is_empty() {
                            log::info!(
                                "[Postcron Step 4] Token extracted via JS: {}...",
                                &token[..50.min(token.len())]
                            );
                            *session = None;

                            // Return as JSON object
                            return Ok(serde_json::json!({
                                "success": true,
                                "token": token,
                                "url": result_obj.get("url").and_then(|u| u.as_str()).unwrap_or("")
                            }));
                        }
                    }

                    // No token found yet, wait and retry
                    log::warn!(
                        "[Postcron Step 4] JS didn't find token yet: {:?}",
                        result_obj
                    );
                }
                Err(e) => {
                    log::error!("[Postcron Step 4] Failed to parse JS result: {}", e);
                }
            }
        }
        Err(e) => {
            log::error!("[Postcron Step 4] JS evaluation failed: {}", e);
        }
    }

    // Fallback: try multiple times with delay
    for i in 0..5 {
        log::info!("[Postcron Step 4] Retry attempt {}...", i + 1);
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        let retry_result = sess
            .page
            .evaluate(
                r#"
            (function() {
                const url = window.location.href;
                if (url.includes('access_token=')) {
                    const hash = url.split('#')[1];
                    if (hash) {
                        const params = new URLSearchParams(hash);
                        const token = params.get('access_token');
                        if (token) return { success: true, token: token };
                    }
                }
                return { success: false };
            })()
        "#,
            )
            .await;

        if let Ok(r) = retry_result {
            if let Ok(obj) = r.into_value::<serde_json::Value>() {
                if let Some(token) = obj.get("token").and_then(|t| t.as_str()) {
                    if !token.is_empty() {
                        log::info!(
                            "[Postcron Step 4] Token found on retry {}: {}...",
                            i + 1,
                            &token[..30]
                        );
                        *session = None;
                        return Ok(serde_json::json!({
                            "success": true,
                            "token": token,
                            "url": ""
                        }));
                    }
                }
            }
        }
    }

    *session = None;
    Err("Failed to extract token after multiple attempts".to_string())
}

// Close postcron browser
#[tauri::command]
async fn postcron_close() -> Result<String, String> {
    let mut session = get_postcron_session().lock().await;
    if let Some(ref sess) = *session {
        let pid = sess.chrome_pid;
        if pid > 0 {
            log::info!("[Postcron] Killing Chrome PID: {}", pid);
            let _ = Command::new("kill").arg(pid.to_string()).output();
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
        } else {
            log::info!("[Postcron] Closing remote Browserless session");
        }
    }
    *session = None;
    log::info!("[Postcron] Session closed");
    Ok("Closed".to_string())
}

// Auto-fill credentials via CDP
async fn inject_autofill(port: u16, username: &str, password: &str) -> Result<(), String> {
    use chromiumoxide::Browser;

    let url = format!("http://127.0.0.1:{}", port);
    log::info!("Connecting to browser for auto-fill at {}", url);

    let (browser, mut handler) = Browser::connect(&url)
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    // Spawn handler
    tokio::spawn(async move { while let Some(_) = handler.next().await {} });

    // Wait a bit more for page to load
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // Get pages
    if let Ok(pages) = browser.pages().await {
        if let Some(page) = pages.into_iter().next() {
            // Inject auto-fill script for Facebook
            let script = format!(
                r#"
                (function() {{
                    // Wait for page to be ready
                    function tryFill() {{
                        // Facebook login selectors
                        const emailInput = document.querySelector('input[name="email"], input[id="email"], input[type="email"], input[type="text"][name="email"]');
                        const passInput = document.querySelector('input[name="pass"], input[id="pass"], input[type="password"]');
                        
                        if (emailInput && passInput) {{
                            emailInput.value = '{}';
                            emailInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                            
                            passInput.value = '{}';
                            passInput.dispatchEvent(new Event('input', {{ bubbles: true }}));
                            
                            console.log('Auto-fill completed');
                            return true;
                        }}
                        return false;
                    }}
                    
                    // Try immediately
                    if (!tryFill()) {{
                        // Retry a few times
                        let attempts = 0;
                        const interval = setInterval(() => {{
                            if (tryFill() || attempts > 10) {{
                                clearInterval(interval);
                            }}
                            attempts++;
                        }}, 500);
                    }}
                }})();
            "#,
                username.replace("'", "\\'").replace("\"", "\\\""),
                password.replace("'", "\\'").replace("\"", "\\\"")
            );

            if let Err(e) = page.evaluate(script).await {
                log::warn!("Failed to inject auto-fill script: {}", e);
            } else {
                log::info!("Auto-fill script injected successfully");
            }
        }
    }

    Ok(())
}

// Launch browser
#[tauri::command]
async fn launch_browser(profile: Profile, state: State<'_, AppState>) -> Result<bool, String> {
    log::info!("Launching browser for: {}", profile.name);
    let profile_id = profile.id.clone();

    {
        let running = state.running_browsers.lock().unwrap();
        if running.contains_key(&profile_id) {
            return Err("Browser already running".to_string());
        }
    }

    // Download latest data (allow up to 2 minutes)
    log::info!("Attempting to download browser data...");
    let download_timeout = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        download_browser_data(profile_id.clone()),
    )
    .await;

    match download_timeout {
        Ok(Ok(_)) => log::info!("Browser data downloaded successfully"),
        Ok(Err(e)) => log::warn!("Download failed, starting fresh: {}", e),
        Err(_) => log::warn!("Download timed out after 2 minutes, starting fresh"),
    }

    let cache_dir = get_cache_dir().join(&profile_id);
    let chrome_path = get_chrome_path();
    let launch_path =
        get_profile_wrapper_exec(&profile, &chrome_path).unwrap_or_else(|| chrome_path.clone());

    // Clear session files to prevent tab restore
    let default_profile = cache_dir.join("Default");
    if default_profile.exists() {
        let session_files = [
            "Current Session",
            "Current Tabs",
            "Last Session",
            "Last Tabs",
        ];
        for file in session_files.iter() {
            let path = default_profile.join(file);
            if path.exists() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    let mut args = vec![
        // Basic settings
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-infobars".to_string(),
        "--disable-popup-blocking".to_string(),
        format!("--user-data-dir={}", cache_dir.display()),

        // Disable session restore
        "--disable-session-crashed-bubble".to_string(),
        "--hide-crash-restore-bubble".to_string(),

        // === STEALTH FLAGS ===
        // Core anti-detection
        "--disable-blink-features=AutomationControlled".to_string(),

        // Override User-Agent to look like regular Chrome (not Chrome for Testing)
        "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36".to_string(),

        // Disable automation-related features
        "--disable-background-networking".to_string(),
        "--disable-client-side-phishing-detection".to_string(),
        "--disable-default-apps".to_string(),
        // --disable-extensions-except is now handled by startup_extension_args()

        // Performance/stability
        "--disable-dev-shm-usage".to_string(),
        "--disable-hang-monitor".to_string(),
        "--disable-ipc-flooding-protection".to_string(),
        "--disable-renderer-backgrounding".to_string(),

        // Privacy-related (reduce tracking vectors)
        "--disable-breakpad".to_string(),
        "--disable-component-update".to_string(),
        "--disable-domain-reliability".to_string(),
        "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process".to_string(),
        "--disable-sync".to_string(),

        // Make it look more like user-launched browser
        "--enable-features=NetworkService,NetworkServiceInProcess".to_string(),
        "--metrics-recording-only".to_string(),
        "--no-service-autorun".to_string(),
        "--password-store=basic".to_string(),
        "--use-mock-keychain".to_string(),

        // Window size to avoid detection by unusual dimensions
        "--window-size=1440,900".to_string(),

        // Language settings
        "--lang=th".to_string(),
        "--accept-lang=th,th-TH,en-US,en".to_string(),
    ];

    if !profile.proxy.is_empty() {
        let proxy_server = if profile.proxy.contains('@') {
            profile.proxy.split('@').last().unwrap_or(&profile.proxy)
        } else {
            &profile.proxy
        };
        args.push(format!("--proxy-server={}", proxy_server));
    }

    // Add remote debugging port (always needed for cookie export)
    let has_credentials = profile.username.as_ref().map_or(false, |u| !u.is_empty())
        || profile.password.as_ref().map_or(false, |p| !p.is_empty());
    let debug_port: u16 = {
        // Always assign a debug port for cookie export
        let existing_ports = state.debug_ports.lock().unwrap();
        let mut port = 49152 + (std::process::id() as u16 % 10000);
        while existing_ports.values().any(|&p| p == port) {
            port += 1;
        }
        port
    };

    args.push(format!("--remote-debugging-port={}", debug_port));
    log::info!("Debug port for {}: {}", profile.name, debug_port);

    for startup_url in startup_urls(&profile).into_iter() {
        args.push(startup_url);
    }
    args.extend(startup_extension_args());

    // Pin extensions to toolbar before launching
    pin_extensions_in_preferences(&cache_dir);

    // Launch Chrome directly with stealth flags
    log::info!("Launching Chrome for profile: {}", profile.name);
    log::info!("Chrome path: {:?}", launch_path);
    log::info!("Args: {:?}", args);

    let child = spawn_chrome_process(&launch_path, &chrome_path, &args).map_err(|e| {
        log::error!("Failed to launch Chrome: {}", e);
        e
    })?;

    let pid = child.id();

    log::info!("Browser launched with PID: {}", pid);

    {
        let mut running = state.running_browsers.lock().unwrap();
        running.insert(profile_id.clone(), pid);
    }

    // Store debug port
    {
        let mut debug_ports = state.debug_ports.lock().unwrap();
        debug_ports.insert(profile_id.clone(), debug_port);
    }

    // Auto-fill credentials if available
    if has_credentials {
        let username = profile.username.clone().unwrap_or_default();
        let password = profile.password.clone().unwrap_or_default();

        tokio::spawn(async move {
            // Wait for browser to start (1.5 sec should be enough)
            tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

            // Try to connect and inject auto-fill script
            if let Err(e) = inject_autofill(debug_port, &username, &password).await {
                log::warn!("Auto-fill failed: {}", e);
            }
        });
    }

    // Monitor browser close
    let profile_id_clone = profile_id.clone();
    let running_browsers = state.running_browsers.clone();
    let uploading_profiles = state.uploading_profiles.clone();
    let debug_ports_clone = state.debug_ports.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            // Check if Chrome process is still running
            let output = Command::new("pgrep")
                .args(["-f", &format!("user-data-dir=.*{}", profile_id_clone)])
                .output();

            match output {
                Ok(o) if o.stdout.is_empty() => {
                    log::info!("Browser closed: {}", profile_id_clone);

                    // Remove from running browsers
                    {
                        let mut running = running_browsers.lock().unwrap();
                        running.remove(&profile_id_clone);
                    }

                    // Remove debug port
                    {
                        let mut debug_ports = debug_ports_clone.lock().unwrap();
                        debug_ports.remove(&profile_id_clone);
                    }

                    let should_upload = {
                        let mut uploading = uploading_profiles.lock().unwrap();
                        if uploading.contains(&profile_id_clone) {
                            false
                        } else {
                            uploading.push(profile_id_clone.clone());
                            true
                        }
                    };

                    if should_upload {
                        log::info!("Uploading data for: {}", profile_id_clone);

                        // Upload data
                        if let Err(e) = upload_browser_data_with_retry(&profile_id_clone).await {
                            log::error!("Failed to upload: {}", e);
                        }

                        // Remove from uploading
                        {
                            let mut uploading = uploading_profiles.lock().unwrap();
                            uploading.retain(|id| id != &profile_id_clone);
                        }
                        log::info!("Upload complete for: {}", profile_id_clone);
                    } else {
                        log::info!(
                            "Skip monitor upload for {} (already uploading via stop flow)",
                            profile_id_clone
                        );
                    }

                    break;
                }
                _ => continue,
            }
        }
    });

    log::info!("Launched browser for: {}", profile.name);
    Ok(true)
}

// Launch browser with a specific URL (overrides homepage)
#[tauri::command]
async fn launch_browser_with_url(
    profile: Profile,
    url: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    log::info!("Launching browser with URL: {} for: {}", url, profile.name);

    // Create a modified profile with the URL as homepage
    let mut modified_profile = profile.clone();
    modified_profile.homepage = Some(url);

    // Use the existing launch_browser logic
    launch_browser(modified_profile, state).await
}

// Launch browser in debug mode with CDP
#[tauri::command]
async fn launch_browser_debug(profile: Profile, state: State<'_, AppState>) -> Result<u16, String> {
    log::info!("Launching browser in DEBUG mode for: {}", profile.name);
    let profile_id = profile.id.clone();

    {
        let running = state.running_browsers.lock().unwrap();
        if running.contains_key(&profile_id) {
            // Check if already in debug mode
            let debug_ports = state.debug_ports.lock().unwrap();
            if let Some(port) = debug_ports.get(&profile_id) {
                return Ok(*port);
            }
            return Err("Browser already running (not in debug mode)".to_string());
        }
    }

    // Find available port (9222 + offset based on running debug browsers)
    let debug_port: u16 = {
        let debug_ports = state.debug_ports.lock().unwrap();
        let base_port = 9222u16;
        let mut port = base_port;
        while debug_ports.values().any(|&p| p == port) {
            port += 1;
            if port > 9300 {
                return Err("No available debug ports".to_string());
            }
        }
        port
    };

    // Download latest data
    log::info!("Attempting to download browser data...");
    let download_timeout = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        download_browser_data(profile_id.clone()),
    )
    .await;

    match download_timeout {
        Ok(Ok(_)) => log::info!("Browser data downloaded successfully"),
        Ok(Err(e)) => log::warn!("Download failed, starting fresh: {}", e),
        Err(_) => log::warn!("Download timed out after 2 minutes, starting fresh"),
    }

    let cache_dir = get_cache_dir().join(&profile_id);
    let chrome_path = get_chrome_path();
    let launch_path =
        get_profile_wrapper_exec(&profile, &chrome_path).unwrap_or_else(|| chrome_path.clone());

    // Clear session files
    let default_profile = cache_dir.join("Default");
    if default_profile.exists() {
        let session_files = [
            "Current Session",
            "Current Tabs",
            "Last Session",
            "Last Tabs",
        ];
        for file in session_files.iter() {
            let path = default_profile.join(file);
            if path.exists() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    let mut args = vec![
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-infobars".to_string(),
        "--disable-popup-blocking".to_string(),
        format!("--user-data-dir={}", cache_dir.display()),
        "--disable-session-crashed-bubble".to_string(),
        "--hide-crash-restore-bubble".to_string(),
        // CDP debug port
        format!("--remote-debugging-port={}", debug_port),
        // Stealth flags
        "--disable-blink-features=AutomationControlled".to_string(),
        "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-client-side-phishing-detection".to_string(),
        "--disable-default-apps".to_string(),
        // --disable-extensions-except is now handled by startup_extension_args()
        "--disable-dev-shm-usage".to_string(),
        "--disable-hang-monitor".to_string(),
        "--disable-ipc-flooding-protection".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-breakpad".to_string(),
        "--disable-component-update".to_string(),
        "--disable-domain-reliability".to_string(),
        "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process".to_string(),
        "--disable-sync".to_string(),
        "--enable-features=NetworkService,NetworkServiceInProcess".to_string(),
        "--metrics-recording-only".to_string(),
        "--no-service-autorun".to_string(),
        "--password-store=basic".to_string(),
        "--use-mock-keychain".to_string(),
        "--window-size=1440,900".to_string(),
        "--lang=th".to_string(),
        "--accept-lang=th,th-TH,en-US,en".to_string(),
    ];

    if !profile.proxy.is_empty() {
        let proxy_server = if profile.proxy.contains('@') {
            profile.proxy.split('@').last().unwrap_or(&profile.proxy)
        } else {
            &profile.proxy
        };
        args.push(format!("--proxy-server={}", proxy_server));
    }

    for startup_url in startup_urls(&profile).into_iter() {
        args.push(startup_url);
    }
    args.extend(startup_extension_args());

    // Pin extensions to toolbar before launching
    pin_extensions_in_preferences(&cache_dir);

    log::info!("Launching Chrome in DEBUG mode on port {}", debug_port);

    let child = spawn_chrome_process(&launch_path, &chrome_path, &args).map_err(|e| {
        log::error!("Failed to launch Chrome: {}", e);
        e
    })?;

    let pid = child.id();
    log::info!(
        "Browser launched with PID: {} on debug port: {}",
        pid,
        debug_port
    );

    {
        let mut running = state.running_browsers.lock().unwrap();
        running.insert(profile_id.clone(), pid);
    }
    {
        let mut debug_ports = state.debug_ports.lock().unwrap();
        debug_ports.insert(profile_id.clone(), debug_port);
    }

    // Monitor browser close
    let profile_id_clone = profile_id.clone();
    let running_browsers = state.running_browsers.clone();
    let uploading_profiles = state.uploading_profiles.clone();
    let debug_ports_clone = state.debug_ports.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            let output = Command::new("pgrep")
                .args(["-f", &format!("user-data-dir=.*{}", profile_id_clone)])
                .output();

            match output {
                Ok(o) if o.stdout.is_empty() => {
                    log::info!("Debug browser closed: {}", profile_id_clone);

                    {
                        let mut running = running_browsers.lock().unwrap();
                        running.remove(&profile_id_clone);
                    }
                    {
                        let mut debug_ports = debug_ports_clone.lock().unwrap();
                        debug_ports.remove(&profile_id_clone);
                    }
                    let should_upload = {
                        let mut uploading = uploading_profiles.lock().unwrap();
                        if uploading.contains(&profile_id_clone) {
                            false
                        } else {
                            uploading.push(profile_id_clone.clone());
                            true
                        }
                    };

                    if should_upload {
                        if let Err(e) = upload_browser_data_with_retry(&profile_id_clone).await {
                            log::error!("Failed to upload: {}", e);
                        }

                        {
                            let mut uploading = uploading_profiles.lock().unwrap();
                            uploading.retain(|id| id != &profile_id_clone);
                        }
                    } else {
                        log::info!(
                            "Skip monitor upload for {} (already uploading via stop flow)",
                            profile_id_clone
                        );
                    }

                    break;
                }
                _ => continue,
            }
        }
    });

    log::info!(
        "Launched debug browser for: {} on port {}",
        profile.name,
        debug_port
    );
    Ok(debug_port)
}

// Get debug port for a profile
#[tauri::command]
fn get_debug_port(profile_id: String, state: State<'_, AppState>) -> Option<u16> {
    let debug_ports = state.debug_ports.lock().unwrap();
    debug_ports.get(&profile_id).copied()
}

// Connect to Chrome CDP and start monitoring
#[tauri::command]
async fn connect_cdp(profile_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let port = {
        let debug_ports = state.debug_ports.lock().unwrap();
        debug_ports.get(&profile_id).copied()
    };

    let port = match port {
        Some(p) => p,
        None => return Err("No debug port found for this profile".to_string()),
    };

    log::info!("Connecting CDP for profile {} on port {}", profile_id, port);

    // Initialize empty logs
    {
        let mut debug_logs = state.debug_logs.lock().unwrap();
        debug_logs.insert(profile_id.clone(), DebugLogs::default());
    }

    // Start CDP monitoring in background using chromiumoxide
    let profile_id_clone = profile_id.clone();
    let debug_logs = state.debug_logs.clone();

    tokio::spawn(async move {
        use chromiumoxide::cdp::browser_protocol::network::{
            EnableParams, EventRequestWillBeSent, EventResponseReceived,
        };

        let connect_result =
            chromiumoxide::Browser::connect(format!("http://127.0.0.1:{}", port)).await;

        match connect_result {
            Ok((browser, mut handler)) => {
                log::info!(
                    "CDP connected successfully for profile {}",
                    profile_id_clone
                );

                // Spawn handler in background
                tokio::spawn(async move { while let Some(_) = handler.next().await {} });

                // Wait for page to be ready and retry
                let mut page_opt = None;
                for attempt in 0..10 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                    if let Ok(pages) = browser.pages().await {
                        log::info!("Attempt {}: Found {} pages", attempt + 1, pages.len());
                        if let Some(p) = pages.into_iter().next() {
                            page_opt = Some(p);
                            break;
                        }
                    }

                    // Try to create a new page if none found
                    if attempt == 3 {
                        log::info!("Trying to create new page...");
                        if let Ok(new_page) = browser.new_page("about:blank").await {
                            page_opt = Some(new_page);
                            break;
                        }
                    }
                }

                if let Some(page) = page_opt {
                    log::info!("Got page, setting up listeners...");
                    // Enable network tracking first!
                    if let Err(e) = page.execute(EnableParams::default()).await {
                        log::error!("Failed to enable network: {}", e);
                    } else {
                        log::info!("Network tracking enabled");
                    }

                    // Listen for network requests
                    if let Ok(mut request_events) =
                        page.event_listener::<EventRequestWillBeSent>().await
                    {
                        let profile_id_net = profile_id_clone.clone();
                        let debug_logs_net = debug_logs.clone();

                        log::info!("Listening for network requests");

                        tokio::spawn(async move {
                            while let Some(event) = request_events.next().await {
                                log::info!(
                                    "Network request: {} {}",
                                    event.request.method,
                                    event.request.url
                                );

                                let log_entry = NetworkLog {
                                    method: event.request.method.to_string(),
                                    url: event.request.url.to_string(),
                                    status: None,
                                    timestamp: std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis()
                                        as u64,
                                };

                                if let Ok(mut logs) = debug_logs_net.lock() {
                                    if let Some(profile_logs) = logs.get_mut(&profile_id_net) {
                                        profile_logs.network.push(log_entry);
                                        if profile_logs.network.len() > 200 {
                                            profile_logs.network.remove(0);
                                        }
                                    }
                                }
                            }
                        });
                    }

                    // Listen for responses to get status codes
                    if let Ok(mut response_events) =
                        page.event_listener::<EventResponseReceived>().await
                    {
                        let profile_id_resp = profile_id_clone.clone();
                        let debug_logs_resp = debug_logs.clone();

                        tokio::spawn(async move {
                            while let Some(event) = response_events.next().await {
                                if let Ok(mut logs) = debug_logs_resp.lock() {
                                    if let Some(profile_logs) = logs.get_mut(&profile_id_resp) {
                                        // Find matching request by URL and update status
                                        if let Some(log) = profile_logs
                                            .network
                                            .iter_mut()
                                            .rev()
                                            .find(|l| l.url == event.response.url.as_str())
                                        {
                                            log.status =
                                                Some(event.response.status.try_into().unwrap_or(0));
                                        }
                                    }
                                }
                            }
                        });
                    }

                    // Get cookies
                    if let Ok(cookies) = page.get_cookies().await {
                        log::info!("Got {} cookies", cookies.len());
                        let cookie_infos: Vec<CookieInfo> = cookies
                            .into_iter()
                            .map(|c| CookieInfo {
                                name: c.name,
                                value: c.value,
                                domain: c.domain,
                            })
                            .collect();

                        if let Ok(mut logs) = debug_logs.lock() {
                            if let Some(profile_logs) = logs.get_mut(&profile_id_clone) {
                                profile_logs.cookies = cookie_infos;
                            }
                        }
                    }
                } else {
                    log::warn!("No pages found after retries");
                }
            }
            Err(e) => {
                log::error!("Failed to connect CDP: {}", e);
            }
        }
    });

    Ok(true)
}

// Get debug logs for a profile
#[tauri::command]
fn get_debug_logs(profile_id: String, state: State<'_, AppState>) -> DebugLogs {
    let debug_logs = state.debug_logs.lock().unwrap();
    debug_logs.get(&profile_id).cloned().unwrap_or_default()
}

// Disconnect CDP (clear logs)
#[tauri::command]
fn disconnect_cdp(profile_id: String, state: State<'_, AppState>) {
    let mut debug_logs = state.debug_logs.lock().unwrap();
    debug_logs.remove(&profile_id);
    log::info!("CDP disconnected for profile {}", profile_id);
}

// Stop browser - Sync first, then close
#[tauri::command]
async fn stop_browser(profile_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    log::info!(
        "Stopping browser for profile: {} - will sync first",
        profile_id
    );

    // 1. Mark as uploading FIRST (so UI shows "Syncing...")
    {
        let mut uploading = state.uploading_profiles.lock().unwrap();
        if !uploading.contains(&profile_id) {
            uploading.push(profile_id.clone());
        }
    }

    // 2. Remove from running (UI will show "Syncing" instead of "Running")
    {
        let mut running = state.running_browsers.lock().unwrap();
        running.remove(&profile_id);
    }

    // 2.5. Export cookies via CDP before killing browser
    let maybe_port = {
        let debug_ports = state.debug_ports.lock().unwrap();
        debug_ports.get(&profile_id).copied()
    };
    if let Some(port) = maybe_port {
        log::info!("Exporting cookies via CDP from port {}...", port);
        if !export_cookies_with_retry(port, &profile_id).await {
            log::warn!(
                "Cookie export skipped: no successful CDP export for {}",
                profile_id
            );
        }
    } else {
        log::warn!("No debug port for cookie export: {}", profile_id);
    }

    // 2.6. Remove debug port
    {
        let mut debug_ports = state.debug_ports.lock().unwrap();
        debug_ports.remove(&profile_id);
    }

    // 3. Gracefully close Chrome (SIGTERM = polite close request)
    log::info!("Sending SIGTERM to browser...");
    let _ = Command::new("pkill")
        .args(["-TERM", "-f", &format!("user-data-dir=.*{}", profile_id)])
        .output();

    // 4. Wait for Chrome to close gracefully (up to 5 seconds)
    for i in 0..10 {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        let output = Command::new("pgrep")
            .args(["-f", &format!("user-data-dir=.*{}", profile_id)])
            .output();

        if let Ok(o) = output {
            if o.stdout.is_empty() {
                log::info!("Browser closed gracefully after {}ms", (i + 1) * 500);
                break;
            }
        }

        // After 3 seconds, force kill if still running
        if i == 6 {
            log::warn!("Browser not responding, force killing...");
            let _ = Command::new("pkill")
                .args(["-KILL", "-f", &format!("user-data-dir=.*{}", profile_id)])
                .output();
        }
    }

    // 5. Wait a bit more for file handles to be released
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // 6. Upload browser data (with retry)
    log::info!("Uploading browser data for: {}", profile_id);
    let upload_result = upload_browser_data_with_retry(profile_id.as_str()).await;

    // 7. Remove from uploading
    {
        let mut uploading = state.uploading_profiles.lock().unwrap();
        uploading.retain(|id| id != &profile_id);
    }

    // 8. Cleanup wrapper app
    cleanup_wrapper_for_profile(&profile_id);

    match upload_result {
        Ok(_) => {
            log::info!(
                "Browser stopped and data synced successfully: {}",
                profile_id
            );
            Ok(true)
        }
        Err(e) => {
            log::error!("Failed to upload data: {}", e);
            Err(format!("Browser stopped but sync failed: {}", e))
        }
    }
}

#[tauri::command]
async fn launch_android_emulator(
    profile: Profile,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let profile_id = profile.id.clone();
    let profile_name = profile.name.clone();

    {
        let running_android = state.running_android_emulators.lock().unwrap();
        if running_android.contains_key(&profile_id) {
            return Err("Android emulator already running for this profile".to_string());
        }
    }

    let emulator_path = get_android_emulator_path().ok_or_else(|| {
        "Android emulator binary not found. Install Android SDK and ensure ANDROID_SDK_ROOT or ANDROID_HOME is set.".to_string()
    })?;

    let avd_name = ensure_android_profile_avd(&profile, &emulator_path)
        .await
        .map_err(|e| {
            log::error!(
                "Resolve Android AVD failed for profile {} ({}): {}",
                profile.name,
                profile_id,
                e
            );
            e
        })?;
    let android_profile_dir = get_android_profile_dir(&profile_id);
    fs::create_dir_all(&android_profile_dir)
        .map_err(|e| format!("Create Android profile dir: {}", e))?;

    log::info!(
        "Launching Android emulator for profile {} with AVD {}",
        profile.name,
        avd_name
    );
    log::info!("Android emulator path: {:?}", emulator_path);
    log::info!("Android datadir: {}", android_profile_dir.display());

    let profile_userdata_path = android_profile_dir.join("userdata-qemu.img");
    let profile_cache_path = android_profile_dir.join("cache.img");
    let profile_snapshots_path = android_profile_dir.join("snapshots.img");
    let is_first_profile_boot = !profile_userdata_path.exists();
    let source_userdata_seed = resolve_source_userdata_seed(&avd_name);

    if is_first_profile_boot {
        if let Some(seed) = source_userdata_seed.as_ref() {
            log::info!(
                "Android userdata seed for profile {}: {}",
                profile_id,
                seed.display()
            );
        } else {
            log::warn!(
                "Android userdata seed not found for AVD {}. Emulator may fail first launch.",
                avd_name
            );
        }
    }

    let adb_path = get_android_adb_path();
    let existing_adb_serials = if let Some(adb) = adb_path.as_ref() {
        match list_adb_emulator_serials(adb) {
            Ok(serials) => serials,
            Err(e) => {
                log::warn!("Cannot list current adb emulator devices: {}", e);
                Vec::new()
            }
        }
    } else {
        log::warn!("ADB binary not found; Android auto-fill will be skipped");
        Vec::new()
    };

    let login_id = resolve_login_identifier(&profile);
    let password = profile.password.clone();

    let mut emulator_cmd = Command::new(&emulator_path);
    emulator_cmd
        .arg("-avd")
        .arg(&avd_name)
        .arg("-datadir")
        .arg(&android_profile_dir)
        .arg("-data")
        .arg(&profile_userdata_path)
        .arg("-cache")
        .arg(&profile_cache_path)
        .arg("-snapstorage")
        .arg(&profile_snapshots_path)
        .arg("-no-snapshot-load")
        .arg("-no-snapshot-save");

    if is_first_profile_boot {
        if let Some(seed) = source_userdata_seed.as_ref() {
            emulator_cmd.arg("-initdata").arg(seed);
        }
    }

    let child = emulator_cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to launch Android emulator: {}", e))?;

    let pid = child.id();
    {
        let mut running_android = state.running_android_emulators.lock().unwrap();
        running_android.insert(profile_id.clone(), pid);
    }

    if let Some(adb) = adb_path.clone() {
        let profile_id_for_fill = profile_id.clone();
        tokio::spawn(async move {
            if let Err(e) = autofill_android_facebook_login(
                profile_id_for_fill.clone(),
                adb,
                existing_adb_serials,
                login_id,
                password,
                is_first_profile_boot,
            )
            .await
            {
                log::warn!(
                    "Android post-launch setup failed for profile {}: {}",
                    profile_id_for_fill,
                    e
                );
            }
        });
    } else {
        log::info!(
            "Android setup skipped for profile {} (missing adb)",
            profile_name
        );
    }

    let running_android = state.running_android_emulators.clone();
    let uploading_android = state.uploading_android_profiles.clone();
    let profile_id_clone = profile_id.clone();
    let avd_name_clone = avd_name.clone();
    tokio::spawn(async move {
        let wait_result = tokio::task::spawn_blocking(move || {
            let mut child = child;
            child.wait()
        })
        .await;

        match wait_result {
            Ok(Ok(status)) => log::info!(
                "Android emulator closed for profile {} (AVD {}, status: {})",
                profile_id_clone,
                avd_name_clone,
                status
            ),
            Ok(Err(e)) => log::warn!(
                "Failed to wait Android emulator process for profile {}: {}",
                profile_id_clone,
                e
            ),
            Err(e) => log::warn!(
                "Android wait task join error for profile {}: {}",
                profile_id_clone,
                e
            ),
        }

        {
            let mut running = running_android.lock().unwrap();
            running.remove(&profile_id_clone);
        }

        {
            let mut uploading = uploading_android.lock().unwrap();
            if !uploading.iter().any(|id| id == &profile_id_clone) {
                uploading.push(profile_id_clone.clone());
            }
        }

        if let Err(e) = upload_android_data(profile_id_clone.clone()).await {
            log::error!(
                "Failed to upload Android data for {}: {}",
                profile_id_clone,
                e
            );
        }

        {
            let mut uploading = uploading_android.lock().unwrap();
            uploading.retain(|id| id != &profile_id_clone);
        }
    });

    Ok(avd_name)
}

// Get running status
// Browser status response
#[derive(Debug, Clone, Serialize)]
pub struct BrowserStatus {
    pub running: Vec<String>,
    pub uploading: Vec<String>,
    pub android_running: Vec<String>,
    pub android_uploading: Vec<String>,
}

#[tauri::command]
fn get_browser_status(state: State<'_, AppState>) -> BrowserStatus {
    let running = state.running_browsers.lock().unwrap();
    let uploading = state.uploading_profiles.lock().unwrap();
    let android_running = state.running_android_emulators.lock().unwrap();
    let android_uploading = state.uploading_android_profiles.lock().unwrap();
    BrowserStatus {
        running: running.keys().cloned().collect(),
        uploading: uploading.clone(),
        android_running: android_running.keys().cloned().collect(),
        android_uploading: android_uploading.clone(),
    }
}

// Get profiles from server
#[tauri::command]
async fn get_profiles() -> Result<Vec<Profile>, String> {
    let server_url = get_server_url();
    let url = format!("{}/api/profiles", server_url);

    let response = reqwest::get(&url).await.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("Failed to get profiles: {}", response.status()));
    }

    response.json().await.map_err(|e| e.to_string())
}

// Create profile
#[tauri::command]
async fn create_profile(
    name: String,
    proxy: String,
    homepage: String,
    notes: String,
    tags: Vec<String>,
    totp_secret: Option<String>,
    username: Option<String>,
    password: Option<String>,
) -> Result<Profile, String> {
    log::info!("📝 create_profile called");
    log::info!("📝 name: {}, totp_secret: {:?}", name, totp_secret);

    let server_url = get_server_url();
    let url = format!("{}/api/profiles", server_url);
    log::info!("📝 URL: {}", url);

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "name": name,
        "proxy": proxy,
        "homepage": homepage,
        "notes": notes,
        "tags": tags,
        "totp_secret": totp_secret,
        "username": username,
        "password": password
    });
    log::info!("📝 Body: {}", body);

    let response = client.post(&url).json(&body).send().await.map_err(|e| {
        log::error!("📝 Request failed: {}", e);
        e.to_string()
    })?;

    log::info!("📝 Response status: {}", response.status());

    if !response.status().is_success() {
        return Err(format!("Failed to create profile: {}", response.status()));
    }

    let profile: Profile = response.json().await.map_err(|e| {
        log::error!("📝 JSON parse failed: {}", e);
        e.to_string()
    })?;

    log::info!("📝 Created profile: {:?}", profile);
    Ok(profile)
}

// Update profile
#[tauri::command]
async fn update_profile(
    id: String,
    name: String,
    proxy: String,
    homepage: String,
    notes: String,
    tags: Vec<String>,
    avatar_url: Option<String>,
    totp_secret: Option<String>,
    username: Option<String>,
    password: Option<String>,
) -> Result<Profile, String> {
    log::info!("📝 update_profile called");
    log::info!(
        "📝 id: {}, name: {}, totp_secret: {:?}",
        id,
        name,
        totp_secret
    );

    let server_url = get_server_url();
    let url = format!("{}/api/profiles/{}", server_url, id);
    log::info!("📝 URL: {}", url);

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "name": name,
        "proxy": proxy,
        "homepage": homepage,
        "notes": notes,
        "tags": tags,
        "avatar_url": avatar_url,
        "totp_secret": totp_secret,
        "username": username,
        "password": password
    });
    log::info!("📝 Body: {}", body);

    let response = client.put(&url).json(&body).send().await.map_err(|e| {
        log::error!("📝 Request failed: {}", e);
        e.to_string()
    })?;

    log::info!("📝 Response status: {}", response.status());

    if !response.status().is_success() {
        let err = format!("Failed to update profile: {}", response.status());
        log::error!("📝 {}", err);
        return Err(err);
    }

    let profile: Profile = response.json().await.map_err(|e| {
        log::error!("📝 JSON parse failed: {}", e);
        e.to_string()
    })?;

    log::info!("📝 Updated profile: {:?}", profile);
    Ok(profile)
}

// Delete profile
#[tauri::command]
async fn delete_profile(id: String) -> Result<bool, String> {
    let server_url = get_server_url();
    let url = format!("{}/api/profiles/{}", server_url, id);

    let client = reqwest::Client::new();
    let response = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(response.status().is_success())
}

// Handle deep link URL
async fn handle_deep_link(url: &str, state: &AppState) {
    log::info!("Handling deep link: {}", url);

    // Parse URL: browsersaving://launch/{profile_id} or browsersaving://stop/{profile_id}
    if let Some(path) = url.strip_prefix("browsersaving://") {
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() >= 2 {
            let action = parts[0];
            let profile_id = parts[1];

            match action {
                "launch" => {
                    log::info!("Deep link: launching profile {}", profile_id);
                    // Fetch profile from server and launch
                    if let Ok(profiles) = get_profiles().await {
                        if let Some(profile) = profiles.into_iter().find(|p| p.id == profile_id) {
                            let state_wrapper = StateWrapper { state };
                            match launch_browser_internal(profile, &state_wrapper).await {
                                Ok(_) => log::info!("Successfully launched browser via deep link"),
                                Err(e) => {
                                    log::error!("Failed to launch browser via deep link: {}", e)
                                }
                            }
                        } else {
                            log::error!("Profile not found: {}", profile_id);
                        }
                    }
                }
                "stop" => {
                    log::info!("Deep link: stopping profile {}", profile_id);
                    let state_wrapper = StateWrapper { state };
                    match stop_browser_internal(profile_id.to_string(), &state_wrapper).await {
                        Ok(_) => log::info!("Successfully stopped browser via deep link"),
                        Err(e) => log::error!("Failed to stop browser via deep link: {}", e),
                    }
                }
                _ => log::warn!("Unknown deep link action: {}", action),
            }
        }
    }
}

// State wrapper for internal use
struct StateWrapper<'a> {
    state: &'a AppState,
}

// Internal launch browser function
async fn launch_browser_internal(
    profile: Profile,
    state: &StateWrapper<'_>,
) -> Result<bool, String> {
    log::info!("Launching browser for: {}", profile.name);
    let profile_id = profile.id.clone();

    {
        let running = state.state.running_browsers.lock().unwrap();
        if running.contains_key(&profile_id) {
            return Err("Browser already running".to_string());
        }
    }

    // Download latest data
    log::info!("Attempting to download browser data...");
    let download_timeout = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        download_browser_data(profile_id.clone()),
    )
    .await;

    match download_timeout {
        Ok(Ok(_)) => log::info!("Browser data downloaded successfully"),
        Ok(Err(e)) => log::warn!("Download failed, starting fresh: {}", e),
        Err(_) => log::warn!("Download timed out after 2 minutes, starting fresh"),
    }

    let cache_dir = get_cache_dir().join(&profile_id);
    let chrome_path = get_chrome_path();
    let launch_path =
        get_profile_wrapper_exec(&profile, &chrome_path).unwrap_or_else(|| chrome_path.clone());

    // Clear session files
    let default_profile = cache_dir.join("Default");
    if default_profile.exists() {
        let session_files = [
            "Current Session",
            "Current Tabs",
            "Last Session",
            "Last Tabs",
        ];
        for file in session_files.iter() {
            let path = default_profile.join(file);
            if path.exists() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    let mut args = vec![
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-infobars".to_string(),
        "--disable-popup-blocking".to_string(),
        format!("--user-data-dir={}", cache_dir.display()),
        "--disable-session-crashed-bubble".to_string(),
        "--hide-crash-restore-bubble".to_string(),
        "--disable-blink-features=AutomationControlled".to_string(),
        "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-client-side-phishing-detection".to_string(),
        "--disable-default-apps".to_string(),
        // --disable-extensions-except is now handled by startup_extension_args()
        "--disable-dev-shm-usage".to_string(),
        "--disable-hang-monitor".to_string(),
        "--disable-ipc-flooding-protection".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-breakpad".to_string(),
        "--disable-component-update".to_string(),
        "--disable-domain-reliability".to_string(),
        "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process".to_string(),
        "--disable-sync".to_string(),
        "--enable-features=NetworkService,NetworkServiceInProcess".to_string(),
        "--metrics-recording-only".to_string(),
        "--no-service-autorun".to_string(),
        "--password-store=basic".to_string(),
        "--use-mock-keychain".to_string(),
        "--window-size=1440,900".to_string(),
        "--lang=th".to_string(),
        "--accept-lang=th,th-TH,en-US,en".to_string(),
    ];

    if !profile.proxy.is_empty() {
        let proxy_server = if profile.proxy.contains('@') {
            profile.proxy.split('@').last().unwrap_or(&profile.proxy)
        } else {
            &profile.proxy
        };
        args.push(format!("--proxy-server={}", proxy_server));
    }

    for startup_url in startup_urls(&profile).into_iter() {
        args.push(startup_url);
    }
    args.extend(startup_extension_args());

    // Pin extensions to toolbar before launching
    pin_extensions_in_preferences(&cache_dir);

    let child = spawn_chrome_process(&launch_path, &chrome_path, &args)?;

    let pid = child.id();
    log::info!("Browser launched with PID: {}", pid);

    {
        let mut running = state.state.running_browsers.lock().unwrap();
        running.insert(profile_id.clone(), pid);
    }

    // Monitor browser close
    let profile_id_clone = profile_id.clone();
    let running_browsers = state.state.running_browsers.clone();
    let uploading_profiles = state.state.uploading_profiles.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            let output = Command::new("pgrep")
                .args(["-f", &format!("user-data-dir=.*{}", profile_id_clone)])
                .output();

            match output {
                Ok(o) if o.stdout.is_empty() => {
                    log::info!("Browser closed: {}", profile_id_clone);

                    {
                        let mut running = running_browsers.lock().unwrap();
                        running.remove(&profile_id_clone);
                    }

                    let should_upload = {
                        let mut uploading = uploading_profiles.lock().unwrap();
                        if uploading.contains(&profile_id_clone) {
                            false
                        } else {
                            uploading.push(profile_id_clone.clone());
                            true
                        }
                    };

                    if should_upload {
                        if let Err(e) = upload_browser_data_with_retry(&profile_id_clone).await {
                            log::error!("Failed to upload: {}", e);
                        }

                        {
                            let mut uploading = uploading_profiles.lock().unwrap();
                            uploading.retain(|id| id != &profile_id_clone);
                        }
                    } else {
                        log::info!(
                            "Skip monitor upload for {} (already uploading via stop flow)",
                            profile_id_clone
                        );
                    }

                    break;
                }
                _ => continue,
            }
        }
    });

    Ok(true)
}

// Internal stop browser function
async fn stop_browser_internal(
    profile_id: String,
    state: &StateWrapper<'_>,
) -> Result<bool, String> {
    log::info!("Stopping browser for profile: {}", profile_id);

    {
        let mut uploading = state.state.uploading_profiles.lock().unwrap();
        if !uploading.contains(&profile_id) {
            uploading.push(profile_id.clone());
        }
    }

    {
        let mut running = state.state.running_browsers.lock().unwrap();
        running.remove(&profile_id);
    }

    let maybe_port = {
        let debug_ports = state.state.debug_ports.lock().unwrap();
        debug_ports.get(&profile_id).copied()
    };
    if let Some(port) = maybe_port {
        log::info!("Exporting cookies via CDP from port {}...", port);
        if !export_cookies_with_retry(port, &profile_id).await {
            log::warn!(
                "Cookie export skipped: no successful CDP export for {}",
                profile_id
            );
        }
    } else {
        log::warn!("No debug port for cookie export: {}", profile_id);
    }
    {
        let mut debug_ports = state.state.debug_ports.lock().unwrap();
        debug_ports.remove(&profile_id);
    }

    let _ = Command::new("pkill")
        .args(["-TERM", "-f", &format!("user-data-dir=.*{}", profile_id)])
        .output();

    for i in 0..10 {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        let output = Command::new("pgrep")
            .args(["-f", &format!("user-data-dir=.*{}", profile_id)])
            .output();

        if let Ok(o) = output {
            if o.stdout.is_empty() {
                break;
            }
        }

        if i == 6 {
            let _ = Command::new("pkill")
                .args(["-KILL", "-f", &format!("user-data-dir=.*{}", profile_id)])
                .output();
        }
    }

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    let upload_result = upload_browser_data_with_retry(profile_id.as_str()).await;

    {
        let mut uploading = state.state.uploading_profiles.lock().unwrap();
        uploading.retain(|id| id != &profile_id);
    }

    cleanup_wrapper_for_profile(&profile_id);

    match upload_result {
        Ok(_) => Ok(true),
        Err(e) => Err(format!("Browser stopped but sync failed: {}", e)),
    }
}

async fn export_cookies_with_retry(port: u16, profile_id: &str) -> bool {
    for attempt in 1..=3 {
        let result = tokio::time::timeout(
            tokio::time::Duration::from_secs(2),
            export_cookies_via_cdp(port, profile_id),
        )
        .await;

        match result {
            Ok(Ok(_count)) => {
                log::info!(
                    "Cookie export success for {} on attempt {}",
                    profile_id,
                    attempt
                );
                return true;
            }
            Ok(Err(e)) => {
                log::warn!(
                    "Cookie export attempt {} failed for {}: {}",
                    attempt,
                    profile_id,
                    e
                );
            }
            Err(_) => {
                log::warn!(
                    "Cookie export attempt {} timed out for {}",
                    attempt,
                    profile_id
                );
            }
        }

        if attempt < 3 {
            tokio::time::sleep(tokio::time::Duration::from_millis(350)).await;
        }
    }

    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: None },
                ))
                .build(),
        )
        .setup(|app| {
            // Handle deep links
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let state = app.state::<AppState>().inner().clone();

                // Register deep link handler
                if let Err(e) = app.deep_link().register("browsersaving") {
                    log::warn!("Failed to register deep link: {}", e);
                }

                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let url_str = url.to_string();
                        let state_clone = state.clone();
                        log::info!("Received deep link: {}", url_str);
                        tokio::spawn(async move {
                            handle_deep_link(&url_str, &state_clone).await;
                        });
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_profiles,
            create_profile,
            update_profile,
            delete_profile,
            launch_browser,
            launch_android_emulator,
            launch_browser_with_url,
            launch_browser_debug,
            get_debug_port,
            connect_cdp,
            get_debug_logs,
            disconnect_cdp,
            stop_browser,
            get_browser_status,
            download_browser_data,
            upload_browser_data,
            get_comment_token_via_script,
            resolve_page_token_via_graph,
            get_facebook_token,
            postcron_step_launch,
            postcron_step_launch_headful,
            postcron_step_navigate,
            postcron_step_click,
            postcron_step_extract,
            postcron_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
