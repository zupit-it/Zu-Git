use crate::models::SecretStoreInfo;

const SERVICE: &str = "dev.giorgio.zugit";

fn account(key: &str) -> &str {
    match key {
        "githubToken" => "github-token",
        "jiraToken" => "jira-token",
        "togglToken" => "toggl-token",
        "googleClientSecret" => "google-client-secret",
        "googleRefreshToken" => "google-refresh-token",
        other => other,
    }
}

// ── macOS: use the `security` CLI directly (same as original Electrobun code) ──

/// Returns true if the secret was stored successfully.
#[cfg(target_os = "macos")]
pub fn get_secret(key: &str) -> String {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            SERVICE,
            "-a",
            account(key),
            "-w",
        ])
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
pub fn set_secret(key: &str, value: &str) -> bool {
    if value.is_empty() {
        let output = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", account(key)])
            .output();

        match output {
            Ok(out) if out.status.success() => true,
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                stderr.contains("could not be found")
                    || stderr.contains("The specified item could not be found")
                    || stderr.contains("-25300")
            }
            Err(_) => false,
        }
    } else {
        // Read back before reporting success: `security` exits 0 even when the
        // prompt round did not take the value (it then stores an empty password).
        write_secret(account(key), value) && get_secret(key) == value
    }
}

/// Stores a secret with `security add-generic-password`, feeding the value to the
/// tool's prompt over stdin.
///
/// The value must never be passed as `-w <value>`: process arguments are visible
/// to every other process of the same user for as long as the command runs.
/// `security` itself says so — "Use of the -p or -w options is insecure".
#[cfg(target_os = "macos")]
fn write_secret(account: &str, value: &str) -> bool {
    use std::io::Write;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut command = Command::new("security");
    command
        .args([
            "add-generic-password",
            "-U",
            "-s",
            SERVICE,
            "-a",
            account,
            // No value: `security` prompts for it, and for a confirmation.
            "-w",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // The prompt goes through readpassphrase(3), which reads from /dev/tty when
    // the process has a controlling terminal and only falls back to stdin when it
    // has none. Detaching the child with setsid() guarantees it reads the pipe
    // below — otherwise running ZuGit from a terminal would hang here forever.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let Ok(mut child) = command.spawn() else {
        return false;
    };

    if let Some(mut stdin) = child.stdin.take() {
        // Value, then the confirmation the prompt asks for.
        if write!(stdin, "{value}\n{value}\n").is_err() {
            return false;
        }
    }

    matches!(child.wait(), Ok(status) if status.success())
}

#[cfg(target_os = "macos")]
fn probe_secure_store() -> Option<String> {
    const CANARY: &str = "__zugit_probe__";

    let run = |args: &[&str]| {
        std::process::Command::new("security")
            .args(args)
            .output()
            .map_err(|e| format!("Could not run `security`: {e}"))
            .and_then(|o| {
                if o.status.success() {
                    Ok(o)
                } else {
                    Err(format!("`security` exited with {}", o.status))
                }
            })
    };

    if !write_secret("__probe__", CANARY) {
        return Some("Keychain write failed".to_string());
    }
    let read = match run(&[
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        "__probe__",
        "-w",
    ]) {
        Ok(o) => o,
        Err(e) => return Some(format!("Keychain read failed: {e}")),
    };
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

// ── File-based token encryption (fallback when keyring fails) ────────────────
//
// On Windows we use DPAPI via PowerShell's ConvertTo/From-SecureString. The
// ciphertext can only be decrypted by the same user on the same machine.
// Other platforms intentionally do not have a file fallback for new writes:
// legacy plaintext values can still be read and migrated, but we never create
// new plaintext token entries.

/// Encrypts a token for storage in the settings file.
/// Returns `dpapi:<hex-blob>` on Windows. Returns an empty string elsewhere.
pub fn encrypt_token_for_file(plaintext: &str) -> String {
    if plaintext.is_empty() {
        return String::new();
    }
    #[cfg(target_os = "windows")]
    {
        encrypt_dpapi(plaintext)
            .map(|c| format!("dpapi:{c}"))
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = plaintext;
        String::new()
    }
}

/// Decrypts a token stored by `encrypt_token_for_file`.
/// Also accepts raw plaintext for backward-compatible migration.
pub fn decrypt_token_from_file(stored: &str) -> String {
    if stored.is_empty() {
        return String::new();
    }
    if let Some(cipher) = stored.strip_prefix("dpapi:") {
        #[cfg(target_os = "windows")]
        return decrypt_dpapi(cipher).unwrap_or_default();
        #[cfg(not(target_os = "windows"))]
        {
            let _ = cipher;
            return String::new();
        }
    }
    if let Some(plain) = stored.strip_prefix("plain:") {
        return plain.to_string();
    }
    // Legacy: no prefix → raw plaintext (Electrobun migration).
    stored.to_string()
}

/// DPAPI encrypt via PowerShell ConvertFrom-SecureString (no key = user+machine).
/// Token is passed via stdin to avoid any quoting/escaping issues.
#[cfg(target_os = "windows")]
fn encrypt_dpapi(plaintext: &str) -> Option<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let script = concat!(
        "$t = $input | Out-String; ",
        "$t = $t.TrimEnd([char]10,[char]13); ",
        "ConvertFrom-SecureString (ConvertTo-SecureString $t -AsPlainText -Force)"
    );

    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(plaintext.as_bytes()).ok()?;
    }

    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// DPAPI decrypt via PowerShell ConvertTo-SecureString.
/// The ciphertext is a hex-only string (safe to embed directly).
/// Uses try/finally to free the BSTR allocated by SecureStringToBSTR.
#[cfg(target_os = "windows")]
fn decrypt_dpapi(ciphertext: &str) -> Option<String> {
    use std::process::{Command, Stdio};

    let script = format!(
        "$ss = ConvertTo-SecureString '{ciphertext}'; \
         $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); \
         try {{ [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) }} \
         finally {{ [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }}"
    );

    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ── Other platforms: use the `keyring` crate ──────────────────────────────────

#[cfg(not(target_os = "macos"))]
pub fn get_secret(key: &str) -> String {
    keyring::Entry::new(SERVICE, account(key))
        .and_then(|e| e.get_password())
        .unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
pub fn set_secret(key: &str, value: &str) -> bool {
    let Ok(entry) = keyring::Entry::new(SERVICE, account(key)) else {
        return false;
    };
    if value.is_empty() {
        // NoEntry is fine — the desired state (nothing stored) is already achieved.
        matches!(
            entry.delete_credential(),
            Ok(()) | Err(keyring::Error::NoEntry)
        )
    } else {
        entry.set_password(value).is_ok()
    }
}

#[cfg(not(target_os = "macos"))]
fn probe_secure_store() -> Option<String> {
    const CANARY: &str = "__zugit_probe__";
    let entry = match keyring::Entry::new(SERVICE, "__probe__") {
        Ok(e) => e,
        Err(e) => return Some(format!("Could not create credential entry: {e}")),
    };
    if entry.set_password(CANARY).is_err() {
        return Some("Could not write to credential store.".to_string());
    }
    let read_back = match entry.get_password() {
        Ok(v) => v,
        Err(e) => return Some(format!("Could not read back from credential store: {e}")),
    };
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
        format!(
            "Windows Credential Manager ({}). Secured by your Windows account.",
            SERVICE
        ),
    );
    #[cfg(target_os = "linux")]
    let (provider, label) = (
        "secret-service",
        format!("Linux Secret Service ({}).", SERVICE),
    );
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let (provider, label) = (
        "fallback-file",
        "No supported system credential store.".to_string(),
    );

    match probe_secure_store() {
        None => SecretStoreInfo {
            provider: provider.to_string(),
            detail: label,
        },
        Some(err) => {
            #[cfg(target_os = "windows")]
            let detail = format!(
                "Secure store probe failed: {}. Tokens can fall back to the app data folder with DPAPI encryption.",
                err
            );
            #[cfg(not(target_os = "windows"))]
            let detail = format!(
                "Secure store probe failed: {}. Tokens cannot be persisted securely until the system credential store is available.",
                err
            );

            SecretStoreInfo {
                provider: "fallback-file".to_string(),
                detail,
            }
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// Round-trips a value through the real keychain to prove the stdin prompt
    /// path stores what it is given — a mismatched prompt would leave the item
    /// empty while `security` still exits 0.
    #[test]
    fn writes_and_reads_back_without_putting_the_secret_in_argv() {
        let key = "__zugit_test_secret__";
        let secret = "tok_ABC-123_xyz~!#$%^&*()_+";

        assert!(set_secret(key, secret), "write should succeed");
        assert_eq!(get_secret(key), secret);

        // Overwriting an existing item goes through the same prompt round.
        let updated = "tok_second_value";
        assert!(set_secret(key, updated), "update should succeed");
        assert_eq!(get_secret(key), updated);

        assert!(set_secret(key, ""), "delete should succeed");
        assert_eq!(get_secret(key), "");
    }
}
