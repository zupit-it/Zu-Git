//! Character packs for the Tiny King's window (meme mode): a zip holding a
//! manifest.json and PNG sheets, as pet-sprites.ts describes them. One loaded
//! takes the Tiny King's place, kept in the app's data folder; the Tiny King
//! built in can be saved as a zip to start from, with a guide to making one.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf, MAIN_SEPARATOR};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// The loaded pack's folder, in the app's data folder.
const DIR: &str = "pet-pack";
const BUILT_IN_NAME: &str = "Tiny King";
/// The Tiny King's pack, in the frontend's assets (public/assets/pet).
const BUILT_IN_ASSETS: &str = "assets/pet";
const GUIDE: &str = include_str!("../pet-pack-guide.md");
const EXPORT_FILE: &str = "zugit-pet-tiny-king.zip";

/// Bounds against a zip that is not a pack, or one that would hurt: memory and
/// disk taken, images that decode to gigabytes, an appearance that never ends.
const MAX_ZIP_BYTES: usize = 64 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// All the sheets together, unpacked: the zip's own size says nothing of it.
const MAX_SHEETS_BYTES: u64 = 64 * 1024 * 1024;
/// All the sheets together, decoded: 4 bytes a pixel, so 256 MB at most.
const MAX_SHEETS_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_ENTRIES: usize = 256;

/// As REQUIRED_CLIPS and PACK_LIMITS in pet-sprites.ts.
const REQUIRED_CLIPS: [&str; 8] = [
    "idle", "pr_merged", "ci_failed", "review_wait",
    "walk_neutral_left", "walk_stop_neutral_left", "walk_start_neutral", "walk_neutral",
];
const CELL: (u64, u64) = (16, 1024);
const COLUMNS: (u64, u64) = (1, 32);
const MAX_CLIPS: usize = 64;
const MAX_FRAMES: usize = 64;
const FRAME_MS: (u64, u64) = (10, 2_000);
/// A clip, one time through; the acts play a few times over.
const MAX_CLIP_MS: u64 = 8_000;
/// A walking frame: with the step's bounds, a walk across stays under half a minute.
const MAX_WALK_FRAME_MS: u64 = 250;
/// walk.step and walk.hidden, as shares of the cell's width.
const STEP_SHARE: (f64, f64) = (1.0 / 96.0, 1.0);
const HIDDEN_SHARE: (f64, f64) = (0.0, 1.5);
const MAX_NAME: usize = 60;
const MAX_FILE_NAME: usize = 64;
/// Names Windows keeps for devices, whatever the extension.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    pub name: String,
    /// False for the Tiny King built in.
    pub custom: bool,
}

/// What the app needs of a manifest, once it reads right.
#[derive(Debug)]
struct Manifest {
    name: String,
    cell: (u32, u32),
    columns: u32,
    /// Each sheet and the most frames a clip reads from it.
    sheets: Vec<(String, usize)>,
    /// The manifest as it is kept: what the app reads of it, nothing more.
    normalized: Value,
}

fn int_in(v: &Value, (min, max): (u64, u64)) -> Option<u64> {
    v.as_u64().filter(|n| (min..=max).contains(n))
}

/// A plain file name: letters, digits, `_`, `-` and dots, ending in .png, not
/// hidden, not one Windows keeps for a device. No path can hide in it.
fn is_sheet_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    name.len() <= MAX_FILE_NAME
        && name.to_ascii_lowercase().ends_with(".png")
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !RESERVED.contains(&stem.as_str())
}

fn is_clip_name(name: &str) -> bool {
    (1..=48).contains(&name.len()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// `value` as a manifest, or what is wrong with it (checkManifest in pet-sprites.ts).
fn check_manifest(value: &Value) -> Result<Manifest, String> {
    let fail = |why: String| Err(format!("Character pack: {why}."));
    if value["format"] != "zugit-pet" || value["version"] != 1 {
        return fail("not a ZuGit pack (format \"zugit-pet\", version 1)".into());
    }
    let name = value["name"].as_str().map(str::trim).unwrap_or("");
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return fail(format!("it needs a name, {MAX_NAME} characters at most"));
    }
    let (Some(width), Some(height)) = (int_in(&value["cell"]["width"], CELL), int_in(&value["cell"]["height"], CELL)) else {
        return fail("cell width and height must be whole px, 16 to 1024".into());
    };
    let Some(columns) = int_in(&value["columns"], COLUMNS) else {
        return fail("columns must be 1 to 32".into());
    };
    let Some(clips) = value["clips"].as_object().filter(|c| c.len() <= MAX_CLIPS) else {
        return fail(format!("clips must be an object of {MAX_CLIPS} clips at most"));
    };
    let mut frames_by_sheet: Vec<(String, usize)> = vec![];
    let mut kept = serde_json::Map::new();
    for (clip, spec) in clips {
        if !is_clip_name(clip) {
            return fail("clip names are lowercase letters, digits and _, 48 at most".into());
        }
        let sheet = spec["sheet"].as_str().unwrap_or("");
        if !is_sheet_name(sheet) {
            return fail(format!("{clip}: sheet must be a plain .png file name"));
        }
        let durations: Vec<u64> = spec["durations"]
            .as_array()
            .map(|d| d.iter().map(|ms| int_in(ms, FRAME_MS).unwrap_or(0)).collect())
            .unwrap_or_default();
        let max_ms = if clip.starts_with("walk_") { MAX_WALK_FRAME_MS } else { FRAME_MS.1 };
        if durations.is_empty() || durations.len() > MAX_FRAMES || durations.iter().any(|&ms| ms == 0 || ms > max_ms) {
            return fail(format!("{clip}: durations must be 1 to {MAX_FRAMES} frames of {} to {max_ms} ms", FRAME_MS.0));
        }
        if durations.iter().sum::<u64>() > MAX_CLIP_MS {
            return fail(format!("{clip}: a clip lasts {} s at most", MAX_CLIP_MS / 1000));
        }
        match frames_by_sheet.iter_mut().find(|(s, _)| s.eq_ignore_ascii_case(sheet)) {
            // Two names apart only by case would be one file on macOS and Windows.
            Some((s, _)) if s != sheet => return fail(format!("{sheet} and {s} differ only by case")),
            Some((_, frames)) => *frames = (*frames).max(durations.len()),
            None => frames_by_sheet.push((sheet.to_string(), durations.len())),
        }
        kept.insert(clip.clone(), serde_json::json!({ "sheet": sheet, "durations": durations }));
    }
    if let Some(missing) = REQUIRED_CLIPS.iter().find(|c| !clips.contains_key(**c)) {
        return fail(format!("clip {missing} is missing"));
    }
    let mut walk = serde_json::Map::new();
    for (key, (min, max)) in [("step", STEP_SHARE), ("hidden", HIDDEN_SHARE)] {
        let v = &value["walk"][key];
        if v.is_null() {
            continue;
        }
        let (lo, hi) = (min * width as f64, max * width as f64);
        match v.as_f64() {
            Some(n) if n > lo && n <= hi || (n == lo && lo > 0.0) => { walk.insert(key.into(), n.into()); }
            _ => return fail(format!("walk.{key} must be over {lo:.1} and at most {hi:.1} px for this cell")),
        }
    }
    let mut normalized = serde_json::json!({
        "format": "zugit-pet",
        "version": 1,
        "name": name,
        "cell": { "width": width, "height": height },
        "columns": columns,
        "clips": kept,
    });
    if !walk.is_empty() {
        normalized["walk"] = walk.into();
    }
    Ok(Manifest {
        name: name.to_string(),
        cell: (width as u32, height as u32),
        columns: columns as u32,
        sheets: frames_by_sheet,
        normalized,
    })
}

/// A PNG's width and height when it is one, whole: the signature, IHDR first,
/// each chunk within the file, IEND last with nothing after it. The pixels are
/// left to the webview's decoder; anything tacked on is refused.
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(SIGNATURE) {
        return None;
    }
    let be = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let mut at = SIGNATURE.len();
    let mut size = None;
    loop {
        let len = be(at)? as usize;
        let kind = bytes.get(at + 4..at + 8)?;
        let end = at.checked_add(12)?.checked_add(len)?;
        if end > bytes.len() {
            return None;
        }
        if at == SIGNATURE.len() {
            if kind != b"IHDR" || len != 13 {
                return None;
            }
            size = Some((be(at + 8)?, be(at + 12)?));
        }
        if kind == b"IEND" {
            return if end == bytes.len() { size } else { None };
        }
        at = end;
    }
}

/// `sheet`'s pixel count, when it holds `frames` cells of `manifest`'s size laid
/// out its way: wide and tall enough for them, and no more.
fn check_sheet(manifest: &Manifest, sheet: &str, frames: usize, bytes: &[u8]) -> Result<u64, String> {
    let Some((width, height)) = png_size(bytes) else {
        return Err(format!("Character pack: {sheet} is not a whole PNG."));
    };
    let columns = manifest.columns as usize;
    let used = frames.min(columns) as u32;
    let rows = frames.div_ceil(columns) as u32;
    let (cw, ch) = manifest.cell;
    let (min_w, max_w, h) = (used * cw, manifest.columns * cw, rows * ch);
    if width < min_w || height < h {
        return Err(format!(
            "Character pack: {sheet} is {width}×{height}, too small for {frames} cells of {cw}×{ch} in {columns} columns."
        ));
    }
    if width > max_w || height > h {
        return Err(format!(
            "Character pack: {sheet} is {width}×{height}, bigger than {max_w}×{h} for {frames} cells of {cw}×{ch} in {columns} columns."
        ));
    }
    Ok(width as u64 * height as u64)
}

fn pack_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(DIR))
}

/// The pack loaded, for the window: its manifest and its folder, ending with a
/// separator. None when the Tiny King built in is the one.
pub fn custom_pack(app: &AppHandle) -> Option<(Value, String)> {
    let dir = pack_dir(app).ok()?;
    let manifest = serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).ok()?).ok()?;
    Some((manifest, format!("{}{}", dir.display(), MAIN_SEPARATOR)))
}

/// A file of the zip read whole, refusing one bigger than `max`.
fn read_entry(entry: &mut impl Read, max: u64, name: &str) -> Result<Vec<u8>, String> {
    let mut bytes = vec![];
    entry.take(max + 1).read_to_end(&mut bytes).map_err(|e| format!("Character pack: {name}: {e}"))?;
    if bytes.len() as u64 > max {
        return Err(format!("Character pack: {name} is too big."));
    }
    Ok(bytes)
}

/// The zip's manifest and sheets, checked: manifest.json at its top, or in the
/// one folder it holds (as zipping a folder makes it).
fn read_pack(zip_bytes: &[u8]) -> Result<(Manifest, Vec<(String, Vec<u8>)>), String> {
    if zip_bytes.len() > MAX_ZIP_BYTES {
        return Err("Character pack: the zip is bigger than 64 MB.".into());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes)).map_err(|e| format!("Character pack: not a zip ({e})."))?;
    if archive.len() > MAX_ENTRIES {
        return Err("Character pack: the zip holds too many files.".into());
    }
    let paths: Vec<Option<PathBuf>> = (0..archive.len())
        .map(|i| archive.by_index(i).ok().filter(|f| f.is_file()).and_then(|f| f.enclosed_name()))
        .collect();
    let is_junk = |p: &Path| p.components().any(|c| c.as_os_str() == "__MACOSX");
    let manifest_at = paths
        .iter()
        .flatten()
        .filter(|p| !is_junk(p) && p.file_name().is_some_and(|n| n == "manifest.json") && p.components().count() <= 2)
        .min_by_key(|p| p.components().count())
        .cloned()
        .ok_or("Character pack: manifest.json not found.")?;
    let folder = manifest_at.parent().map(Path::to_path_buf).unwrap_or_default();
    let index_of = |name: &str| paths.iter().position(|p| p.as_deref() == Some(folder.join(name).as_path()));

    let manifest_text = {
        let i = index_of("manifest.json").ok_or("Character pack: manifest.json not found.")?;
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        String::from_utf8(read_entry(&mut entry, MAX_MANIFEST_BYTES, "manifest.json")?)
            .map_err(|_| "Character pack: manifest.json is not UTF-8 text.".to_string())?
    };
    let value: Value = serde_json::from_str(&manifest_text).map_err(|e| format!("Character pack: manifest.json: {e}."))?;
    let manifest = check_manifest(&value)?;

    let mut sheets = vec![];
    let (mut total_bytes, mut total_pixels) = (0u64, 0u64);
    for (sheet, frames) in &manifest.sheets {
        let i = index_of(sheet).ok_or_else(|| format!("Character pack: {sheet} is not in the zip."))?;
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let bytes = read_entry(&mut entry, MAX_FILE_BYTES, sheet)?;
        total_pixels += check_sheet(&manifest, sheet, *frames, &bytes)?;
        total_bytes += bytes.len() as u64;
        if total_bytes > MAX_SHEETS_BYTES {
            return Err(format!("Character pack: its sheets take more than {} MB.", MAX_SHEETS_BYTES >> 20));
        }
        if total_pixels > MAX_SHEETS_PIXELS {
            return Err(format!("Character pack: its sheets hold more than {}M pixels.", MAX_SHEETS_PIXELS >> 20));
        }
        sheets.push((sheet.clone(), bytes));
    }
    Ok((manifest, sheets))
}

/// Loads the pack in the zip sent as the request's body, in the Tiny King's place.
#[tauri::command]
pub async fn pet_pack_import(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<PackInfo, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Character pack: expected the zip's bytes.".into());
    };
    let (manifest, sheets) = read_pack(bytes)?;
    let manifest_text = serde_json::to_string_pretty(&manifest.normalized).map_err(|e| e.to_string())?;

    // Written aside, then swapped in: a pack half written is never the one shown.
    let dir = pack_dir(&app)?;
    let fresh = dir.with_extension("new");
    let _ = std::fs::remove_dir_all(&fresh);
    std::fs::create_dir_all(&fresh).map_err(|e| e.to_string())?;
    std::fs::write(fresh.join("manifest.json"), manifest_text).map_err(|e| e.to_string())?;
    for (sheet, bytes) in sheets {
        std::fs::write(fresh.join(sheet), bytes).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&fresh, &dir).map_err(|e| e.to_string())?;
    Ok(PackInfo { name: manifest.name, custom: true })
}

/// Back to the Tiny King built in.
#[tauri::command]
pub fn pet_pack_reset(app: AppHandle) -> Result<PackInfo, String> {
    let dir = pack_dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(PackInfo { name: BUILT_IN_NAME.into(), custom: false })
}

/// Who walks on screen now.
#[tauri::command]
pub fn pet_pack_info(app: AppHandle) -> PackInfo {
    match custom_pack(&app).and_then(|(m, _)| m["name"].as_str().map(str::to_string)) {
        Some(name) => PackInfo { name, custom: true },
        None => PackInfo { name: BUILT_IN_NAME.into(), custom: false },
    }
}

/// A file of the Tiny King's pack: from the frontend's assets, or in a debug
/// build without them, from public/ in the source tree.
fn built_in_file(app: &AppHandle, name: &str) -> Option<Vec<u8>> {
    let asset = app.asset_resolver().get(format!("{BUILT_IN_ASSETS}/{name}")).map(|a| a.bytes);
    #[cfg(debug_assertions)]
    let asset = asset.or_else(|| {
        std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../public").join(BUILT_IN_ASSETS).join(name)).ok()
    });
    asset
}

/// The Tiny King's pack as a zip, from `file`: manifest.json, the sheets and GUIDE.md.
fn built_in_zip(file: impl Fn(&str) -> Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let manifest_bytes = file("manifest.json").ok_or("The Tiny King's manifest is missing.")?;
    let value: Value = serde_json::from_slice(&manifest_bytes).map_err(|e| format!("The Tiny King's manifest: {e}"))?;
    let manifest = check_manifest(&value)?;

    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;
    let text = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    // PNGs are compressed already.
    let image = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut add = |name: &str, bytes: &[u8], options: SimpleFileOptions| -> Result<(), String> {
        zip.start_file(format!("tiny-king/{name}"), options).map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())
    };
    add("manifest.json", &manifest_bytes, text)?;
    add("GUIDE.md", GUIDE.as_bytes(), text)?;
    for (sheet, frames) in &manifest.sheets {
        let bytes = file(sheet).ok_or_else(|| format!("The Tiny King's {sheet} is missing."))?;
        // A missing asset can come back as the app's page: only a sheet goes in.
        check_sheet(&manifest, sheet, *frames, &bytes)?;
        add(sheet, &bytes, image)?;
    }
    Ok(zip.finish().map_err(|e| e.to_string())?.into_inner())
}

/// `file` in `folder`, or `name (2).zip` and on when it is taken: a file of the
/// user's is never written over.
fn free_name(folder: &Path, file: &str) -> PathBuf {
    let (stem, ext) = file.rsplit_once('.').unwrap_or((file, ""));
    (1..)
        .map(|n| folder.join(if n == 1 { file.to_string() } else { format!("{stem} ({n}).{ext}") }))
        .find(|path| !path.exists())
        .expect("some name is free")
}

/// Saves the Tiny King's pack to the Downloads folder (home when there is
/// none), shows it in the file manager and says where it is.
#[tauri::command]
pub async fn pet_pack_export(app: AppHandle) -> Result<String, String> {
    let bytes = built_in_zip(|name| built_in_file(&app, name))?;
    let folder = dirs::download_dir().or_else(dirs::home_dir).ok_or("No Downloads folder to save to.")?;
    let path = free_name(&folder, EXPORT_FILE);
    std::fs::write(&path, bytes).map_err(|e| format!("Unable to save {}: {e}", path.display()))?;
    {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().reveal_item_in_dir(&path);
    }
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    /// A PNG as far as the checks read one: signature, IHDR, IEND. Its pixels
    /// are not there; the webview would refuse it, the checks need not.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend([8, 6, 0, 0, 0]);
        bytes.extend([0; 4]); // CRC
        bytes.extend(b"\0\0\0\0IEND");
        bytes.extend([0; 4]);
        bytes
    }

    fn manifest() -> Value {
        let clips: serde_json::Map<String, Value> = REQUIRED_CLIPS
            .iter()
            .map(|c| (c.to_string(), serde_json::json!({ "sheet": format!("{c}.png"), "durations": [100, 100, 100, 100, 100] })))
            .collect();
        serde_json::json!({ "format": "zugit-pet", "version": 1, "name": "Pixel", "cell": { "width": 32, "height": 48 }, "columns": 4, "clips": clips })
    }

    fn zip_with(manifest: &Value, prefix: &str, sheet: Vec<u8>) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(format!("{prefix}manifest.json"), SimpleFileOptions::default()).unwrap();
        zip.write_all(manifest.to_string().as_bytes()).unwrap();
        let sheets: std::collections::BTreeSet<&str> = manifest["clips"].as_object().unwrap().values().filter_map(|c| c["sheet"].as_str()).collect();
        for name in sheets {
            zip.start_file(format!("{prefix}{name}"), SimpleFileOptions::default()).unwrap();
            zip.write_all(&sheet).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn zip_pack(prefix: &str, sheet: Vec<u8>) -> Vec<u8> {
        zip_with(&manifest(), prefix, sheet)
    }

    fn refused(manifest: Value) -> String {
        check_manifest(&manifest).unwrap_err()
    }

    #[test]
    fn a_pack_reads_at_the_top_or_in_its_one_folder() {
        // 5 frames in 4 columns: 2 rows of 32 × 48 cells.
        let (m, sheets) = read_pack(&zip_pack("", png(128, 96))).unwrap();
        assert_eq!((m.name.as_str(), m.cell, sheets.len()), ("Pixel", (32, 48), 8));
        assert!(read_pack(&zip_pack("pixel/", png(128, 96))).is_ok());
        assert!(read_pack(&zip_pack("a/b/", png(128, 96))).unwrap_err().contains("manifest.json not found"));
        assert!(read_pack(b"plain text").unwrap_err().contains("not a zip"));
    }

    #[test]
    fn only_what_the_app_reads_of_a_manifest_is_kept() {
        let mut extra = manifest();
        extra["script"] = "<script>alert(1)</script>".into();
        extra["clips"]["idle"]["onload"] = "x".into();
        let kept = check_manifest(&extra).unwrap().normalized;
        assert!(kept.get("script").is_none());
        assert_eq!(kept["clips"]["idle"], serde_json::json!({ "sheet": "idle.png", "durations": [100, 100, 100, 100, 100] }));
    }

    #[test]
    fn a_sheet_name_is_a_plain_file_and_never_a_device() {
        for bad in ["../evil.png", "a/b.png", "a\\b.png", ".hidden.png", "idle.svg", "CON.png", "nul.png", "com1.sprite.png", ""] {
            let mut m = manifest();
            m["clips"]["idle"]["sheet"] = bad.into();
            assert!(refused(m).contains("idle: sheet"), "{bad:?} got in");
        }
        let mut case = manifest();
        case["clips"]["idle"]["sheet"] = "Walk_Neutral.png".into();
        assert!(refused(case).contains("differ only by case"));
    }

    #[test]
    fn a_manifest_is_refused_for_what_is_wrong_with_it() {
        let mut missing = manifest();
        missing["clips"].as_object_mut().unwrap().remove("review_wait");
        assert_eq!(refused(missing), "Character pack: clip review_wait is missing.");
        let mut other = manifest();
        other["format"] = "something-else".into();
        assert!(refused(other).contains("not a ZuGit pack"));
        let mut shouting = manifest();
        shouting["clips"]["IDLE"] = shouting["clips"]["idle"].clone();
        assert!(refused(shouting).contains("clip names"));
        let mut controls = manifest();
        controls["name"] = "Pixel\u{0007}".into();
        assert!(refused(controls).contains("needs a name"));
    }

    #[test]
    fn he_cannot_be_made_to_stay_on_screen_for_ever() {
        let mut slow_frame = manifest();
        slow_frame["clips"]["idle"]["durations"] = serde_json::json!([5000]);
        assert!(refused(slow_frame).contains("idle: durations"));
        let mut long_clip = manifest();
        long_clip["clips"]["idle"]["durations"] = serde_json::json!([2000, 2000, 2000, 2000, 2000]);
        assert!(refused(long_clip).contains("8 s at most"));
        let mut slow_walk = manifest();
        slow_walk["clips"]["walk_neutral_left"]["durations"] = serde_json::json!([600]);
        assert!(refused(slow_walk).contains("walk_neutral_left: durations"));
        let mut crawl = manifest();
        crawl["walk"] = serde_json::json!({ "step": 0.01 });
        assert!(refused(crawl).contains("walk.step"));
        let mut far = manifest();
        far["walk"] = serde_json::json!({ "hidden": 10_000 });
        assert!(refused(far).contains("walk.hidden"));
        let mut fine = manifest();
        fine["walk"] = serde_json::json!({ "step": 1, "hidden": 30 });
        assert!(check_manifest(&fine).is_ok());
    }

    #[test]
    fn a_sheet_must_be_a_whole_png_of_the_size_it_should_be() {
        let err = |sheet: Vec<u8>| read_pack(&zip_pack("", sheet)).unwrap_err();
        assert!(err(png(96, 96)).contains("too small"));
        // Few bytes that would decode to gigabytes.
        assert!(err(png(30_000, 30_000)).contains("bigger than"));
        assert!(err(b"not a png".to_vec()).contains("not a whole PNG"));
        let mut tacked = png(128, 96);
        tacked.extend(b"<html><script>alert(1)</script>");
        assert!(err(tacked).contains("not a whole PNG"));
        let mut cut = png(128, 96);
        cut.truncate(30);
        assert!(err(cut).contains("not a whole PNG"));
    }

    #[test]
    fn a_pack_is_bounded_in_bytes_and_pixels_altogether() {
        let mut big = vec![0u8; (MAX_FILE_BYTES + 10) as usize];
        big[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        assert!(read_pack(&zip_pack("", big)).unwrap_err().contains("too big"));

        // Each sheet within its bounds, all of them together far past them.
        let mut huge = manifest();
        huge["cell"] = serde_json::json!({ "width": 1024, "height": 1024 });
        huge["columns"] = 32.into();
        for (i, clip) in huge["clips"].as_object_mut().unwrap().values_mut().enumerate() {
            *clip = serde_json::json!({ "sheet": format!("s{i}.png"), "durations": vec![100; 32] });
        }
        assert!(read_pack(&zip_with(&huge, "", png(32 * 1024, 1024))).unwrap_err().contains("pixels"));
    }

    #[test]
    fn the_tiny_kings_pack_saved_loads_back() {
        let public = Path::new(env!("CARGO_MANIFEST_DIR")).join("../public").join(BUILT_IN_ASSETS);
        let zip = built_in_zip(|name| std::fs::read(public.join(name)).ok()).unwrap();
        let (manifest, sheets) = read_pack(&zip).unwrap();
        assert_eq!(manifest.name, "Tiny King");
        assert_eq!(sheets.len(), 17);
        let mut archive = zip::ZipArchive::new(Cursor::new(zip)).unwrap();
        assert!(archive.by_name("tiny-king/GUIDE.md").is_ok());
    }

    #[test]
    fn a_saved_pack_never_writes_over_a_file() {
        let folder = std::env::temp_dir().join(format!("zugit-free-name-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(free_name(&folder, "pack.zip"), folder.join("pack.zip"));
        std::fs::write(folder.join("pack.zip"), b"mine").unwrap();
        std::fs::write(folder.join("pack (2).zip"), b"mine too").unwrap();
        assert_eq!(free_name(&folder, "pack.zip"), folder.join("pack (3).zip"));
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
