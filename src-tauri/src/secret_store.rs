use crate::models::SecretStoreInfo;

const SERVICE: &str = "dev.giorgio.zugit";

fn account(key: &str) -> &str {
    match key {
        "githubToken" => "github-token",
        "jiraToken" => "jira-token",
        other => other,
    }
}

// ── macOS: use the `security` CLI directly (same as original Electrobun code) ──

#[cfg(target_os = "macos")]
pub fn get_secret(key: &str) -> String {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", SERVICE, "-a", account(key), "-w"])
        .output()
        .ok();
    match output {
        Some(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
        _ => String::new(),
    }
}

#[cfg(target_os = "macos")]
pub fn set_secret(key: &str, value: &str) {
    if value.is_empty() {
        let _ = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", account(key)])
            .output();
    } else {
        let _ = std::process::Command::new("security")
            .args(["add-generic-password", "-U", "-s", SERVICE, "-a", account(key), "-w", value])
            .output();
    }
}

#[cfg(target_os = "macos")]
fn probe_secure_store() -> Option<String> {
    const CANARY: &str = "__zugit_probe__";
    let write = std::process::Command::new("security")
        .args(["add-generic-password", "-U", "-s", SERVICE, "-a", "__probe__", "-w", CANARY])
        .output()
        .ok()?;
    if !write.status.success() {
        return Some("Could not write to macOS Keychain.".to_string());
    }
    let read = std::process::Command::new("security")
        .args(["find-generic-password", "-s", SERVICE, "-a", "__probe__", "-w"])
        .output()
        .ok()?;
    let _ = std::process::Command::new("security")
        .args(["delete-generic-password", "-s", SERVICE, "-a", "__probe__"])
        .output();
    let read_back = String::from_utf8_lossy(&read.stdout).trim().to_string();
    if read_back == CANARY {
        None
    } else {
        Some(format!("Probe read-back mismatch (got \"{}\")", read_back))
    }
}

// ── Other platforms: use the `keyring` crate ──────────────────────────────────

#[cfg(not(target_os = "macos"))]
pub fn get_secret(key: &str) -> String {
    keyring::Entry::new(SERVICE, account(key))
        .and_then(|e| e.get_password())
        .unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
pub fn set_secret(key: &str, value: &str) {
    if let Ok(entry) = keyring::Entry::new(SERVICE, account(key)) {
        if value.is_empty() {
            let _ = entry.delete_credential();
        } else {
            let _ = entry.set_password(value);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn probe_secure_store() -> Option<String> {
    const CANARY: &str = "__zugit_probe__";
    let entry = keyring::Entry::new(SERVICE, "__probe__").ok()?;
    entry.set_password(CANARY).ok()?;
    let read_back = entry.get_password().ok()?;
    let _ = entry.delete_credential();
    if read_back == CANARY {
        None
    } else {
        Some(format!("Probe read-back mismatch (got \"{}\")", read_back))
    }
}

// ── Secret store info (all platforms) ────────────────────────────────────────

pub fn get_secret_store_info() -> SecretStoreInfo {
    #[cfg(target_os = "macos")]
    let (provider, label) = ("keychain", format!("macOS Keychain ({}).", SERVICE));
    #[cfg(target_os = "windows")]
    let (provider, label) = (
        "credential-manager",
        format!("Windows Credential Manager ({}). Secured by your Windows account.", SERVICE),
    );
    #[cfg(target_os = "linux")]
    let (provider, label) = ("secret-service", format!("Linux Secret Service ({}).", SERVICE));
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let (provider, label) = ("fallback-file", "No supported system credential store.".to_string());

    match probe_secure_store() {
        None => SecretStoreInfo { provider: provider.to_string(), detail: label },
        Some(err) => SecretStoreInfo {
            provider: "fallback-file".to_string(),
            detail: format!("Secure store probe failed: {}. Tokens will not persist between sessions.", err),
        },
    }
}
