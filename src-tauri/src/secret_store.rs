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

/// Stores (or, for an empty value, removes) a secret.
///
/// The error carries the reason so the caller can tell the user what actually
/// went wrong instead of a bare "could not save".
#[cfg(target_os = "macos")]
pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        let output = std::process::Command::new("security")
            .args(["delete-generic-password", "-s", SERVICE, "-a", account(key)])
            .output();

        return match output {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                // Nothing stored is the state we wanted anyway.
                if stderr.contains("could not be found")
                    || stderr.contains("The specified item could not be found")
                    || stderr.contains("-25300")
                {
                    Ok(())
                } else {
                    Err(format!("keychain delete failed: {}", stderr.trim()))
                }
            }
            Err(e) => Err(format!("could not run `security`: {e}")),
        };
    }

    write_secret(account(key), value)?;
    // Read back before reporting success: `security` can exit 0 having stored
    // something other than what it was handed — that is how the 128-character
    // truncation of the old prompt-based write went unnoticed until a long Jira
    // token hit it.
    if get_secret(key) == value {
        Ok(())
    } else {
        Err("the keychain accepted the write but the value did not read back".to_string())
    }
}

/// Stores a secret by feeding `security` the whole command on stdin, in its
/// interactive mode, with the value hex-encoded.
///
/// Three constraints have to hold at once, and this is the only combination that
/// satisfies all of them:
///
/// * **Not in `argv`** — process arguments are readable by any other process of
///   the same user while the command runs, so `-w <value>` is out. `security`
///   itself says as much: "Use of the -p or -w options is insecure".
/// * **No length limit** — prompting for the value (`-w` with no argument) keeps
///   it out of `argv`, but the prompt goes through `readpassphrase(3)`, which
///   silently truncates at 128 characters. An Atlassian API token is around 192,
///   so that path corrupts exactly the longest and most important tokens.
/// * **No quoting bugs** — interactive mode splits the command line on spaces,
///   so a secret containing a space or a quote would be mangled. Hex has neither.
#[cfg(target_os = "macos")]
fn write_secret(account: &str, value: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    // `security` prints a stored secret verbatim when it is ASCII and as hex when
    // it is not, with no marker to tell the two apart — a non-ASCII secret would
    // therefore read back as a hex string and break the integration silently.
    // Refusing it up front is the honest outcome; every token we store is ASCII.
    if !value.is_ascii() {
        return Err(
            "the value contains non-ASCII characters, which the keychain cannot round-trip \
             reliably — check for a stray character in the pasted token"
                .to_string(),
        );
    }

    let hex: String = value.bytes().map(|b| format!("{b:02x}")).collect();

    let mut command = Command::new("security");
    command
        .arg("-i") // read commands from stdin; the value never reaches argv
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // Detach from any controlling terminal so `security` can never decide to talk
    // to /dev/tty instead of the pipe below.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run `security`: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        writeln!(
            stdin,
            "add-generic-password -U -s {SERVICE} -a {account} -X {hex}"
        )
        .map_err(|e| format!("could not hand the secret to `security`: {e}"))?;
        // Closing stdin ends interactive mode.
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("could not wait for `security`: {e}"))?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "`security` exited with {}{}",
        output.status,
        if stderr.trim().is_empty() {
            String::new()
        } else {
            format!(": {}", stderr.trim())
        }
    ))
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

    if let Err(reason) = write_secret("__probe__", CANARY) {
        return Some(format!("Keychain write failed: {reason}"));
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
pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, account(key))
        .map_err(|e| format!("could not open the credential entry: {e}"))?;
    if value.is_empty() {
        // NoEntry is fine — the desired state (nothing stored) is already achieved.
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("credential delete failed: {e}")),
        };
    }
    entry
        .set_password(value)
        .map_err(|e| format!("credential write failed: {e}"))
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

    /// Round-trips values through the real keychain: the write path has to store
    /// exactly what it was given, whatever the secret looks like.
    #[test]
    fn writes_and_reads_back_without_putting_the_secret_in_argv() {
        let key = "__zugit_test_secret__";
        let secret = "tok_ABC-123_xyz~!#$%^&*()_+";

        assert!(set_secret(key, secret).is_ok(), "write should succeed");
        assert_eq!(get_secret(key), secret);

        // Overwriting an existing item goes through the same path.
        let updated = "tok_second_value";
        assert!(set_secret(key, updated).is_ok(), "update should succeed");
        assert_eq!(get_secret(key), updated);

        assert!(set_secret(key, "").is_ok(), "delete should succeed");
        assert_eq!(get_secret(key), "");
    }

    /// The regression that made saving Jira settings fail: an Atlassian API token
    /// is ~192 characters, and the previous write path (prompting for the value)
    /// truncated it at 128 without saying so.
    #[test]
    fn stores_a_token_longer_than_the_prompt_buffer() {
        let key = "__zugit_test_long__";
        let secret = format!("ATATT3xFfGF0{}", "x".repeat(180));
        assert_eq!(secret.len(), 192);

        assert!(set_secret(key, &secret).is_ok(), "192-char write should succeed");
        assert_eq!(get_secret(key), secret);
        assert!(set_secret(key, "").is_ok());
    }

    /// Interactive mode splits the command on spaces, so anything shell-like in
    /// the secret would be mangled if it were not hex-encoded.
    #[test]
    fn stores_a_secret_with_spaces_and_shell_characters() {
        let key = "__zugit_test_weird__";
        let secret = r#"p@ss "quoted" $VAR \back `tick` #hash with spaces"#;

        assert!(set_secret(key, secret).is_ok(), "write should succeed");
        assert_eq!(get_secret(key), secret);
        assert!(set_secret(key, "").is_ok());
    }

    /// A non-ASCII secret cannot be read back unambiguously, so it is refused
    /// with an explanation instead of being stored and silently misread later.
    #[test]
    fn refuses_a_non_ascii_secret_instead_of_corrupting_it() {
        let error = set_secret("__zugit_test_utf8__", "chiavé—unicode").unwrap_err();
        assert!(error.contains("non-ASCII"), "unexpected message: {error}");
        assert_eq!(get_secret("__zugit_test_utf8__"), "");
    }
}
