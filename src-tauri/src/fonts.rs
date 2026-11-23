//! System font discovery.
//!
//! Cadence enumerates the fonts the operating system actually has installed instead of shipping a
//! fixed list, so a font installed after the build shows up without a code change. Each platform is
//! read through its own font store:
//!
//! * Windows — the per-machine and per-user font directories (`%WINDIR%\Fonts`,
//!   `%LOCALAPPDATA%\Microsoft\Windows\Fonts`). These are the directories the shell and the
//!   font control panel install into.
//! * macOS — the system, supplemental, local-domain and per-user font directories.
//! * Linux and other Unix — `fc-list` (fontconfig) when it is available, with a directory scan as
//!   the fallback. `fc-list` is the platform's own font database, so it honours every `<dir>` in
//!   `fonts.conf` and every user font directory.
//!
//! Family names are read from the fonts themselves (the sfnt `name` table, including `ttc`/`otc`
//! collections), not from file names: the family is what CSS `font-family` needs, and file names
//! routinely disagree with it. Only the table directory and the `name` table are read, so scanning a
//! few hundred fonts costs a handful of kilobytes per file rather than the whole files.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// One installed family and the face styles the system has for it.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFamily {
    /// The family name to put in CSS `font-family` (already trimmed).
    pub family: String,
    /// Distinct subfamily names found for this family, sorted (e.g. "Regular", "Bold").
    pub styles: Vec<String>,
}

/// A family name is attacker-controlled input from a font file; keep it short and printable.
const MAX_FAMILY_CHARS: usize = 120;
/// Never read a whole font into memory; only its header and `name` table.
const MAX_NAME_TABLE_BYTES: usize = 1024 * 1024;
/// Font collections and a few CJK families are large, but nothing legitimate is this large.
const MAX_FONT_FILE_BYTES: u64 = 128 * 1024 * 1024;
/// Font directories are shallow; this also bounds symlink cycles.
const MAX_SCAN_DEPTH: usize = 10;
/// Only these are system-installed face formats (WOFF is a web format, not an installed one).
const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "ttc", "otc"];

fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| FONT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn read_u16_at(file: &mut File, offset: u64) -> Option<u16> {
    let mut buffer = [0u8; 2];
    file.seek(SeekFrom::Start(offset)).ok()?;
    file.read_exact(&mut buffer).ok()?;
    Some(u16::from_be_bytes(buffer))
}

fn u16_be(bytes: &[u8], index: usize) -> Option<u16> {
    let hi = *bytes.get(index)?;
    let lo = *bytes.get(index.checked_add(1)?)?;
    Some(u16::from_be_bytes([hi, lo]))
}

/// Decodes one `name`-table string. Windows and Unicode records are UTF-16BE; Macintosh records use
/// the Mac Roman byte set, which is ASCII for every family name in practice. Returns `None` for a
/// malformed or empty value.
fn decode_name(platform_id: u16, bytes: &[u8]) -> Option<String> {
    let raw = match platform_id {
        0 | 3 => {
            if bytes.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16(&units).ok()?
        }
        1 => bytes.iter().map(|byte| *byte as char).collect(),
        _ => return None,
    };
    let cleaned: String = raw.chars().filter(|ch| !ch.is_control()).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned.chars().count() > MAX_FAMILY_CHARS {
        None
    } else {
        Some(cleaned.to_string())
    }
}

/// How much to trust one `name` record as the family's canonical (English) name. A font can carry
/// the same name in several scripts; the Windows en-US record is what font pickers and CSS on
/// every platform show, so it ranks first, and localized records only fill in when nothing
/// English exists.
fn name_rank(platform_id: u16, language_id: u16) -> u8 {
    match platform_id {
        3 if language_id == 0x0409 => 0,
        3 if (language_id & 0x3ff) == 0x009 => 1,
        0 => 2,
        1 if language_id == 0 => 3,
        1 => 4,
        3 => 5,
        _ => 6,
    }
}

struct NameCandidate {
    rank: u8,
    value: String,
}

fn keep_best(slot: &mut Option<NameCandidate>, rank: u8, value: String) {
    match slot {
        Some(current) if current.rank <= rank => {}
        _ => *slot = Some(NameCandidate { rank, value }),
    }
}

/// Parses the `name` table of one face. Prefers the typographic family/subfamily (IDs 16/17) over
/// the legacy family/subfamily (IDs 1/2), because the typographic names keep "Arial" + "Bold"
/// separate while the legacy names can fold the style into the family ("Arial Bold").
fn parse_name_table(data: &[u8]) -> Option<(String, String)> {
    if data.len() < 6 {
        return None;
    }
    let count = u16_be(data, 2)? as usize;
    let string_offset = u16_be(data, 4)? as usize;
    if count > 4096 {
        return None;
    }
    let mut typographic_family: Option<NameCandidate> = None;
    let mut legacy_family: Option<NameCandidate> = None;
    let mut typographic_style: Option<NameCandidate> = None;
    let mut legacy_style: Option<NameCandidate> = None;
    for index in 0..count {
        let record = 6 + index * 12;
        if record + 12 > data.len() {
            break;
        }
        let platform_id = u16_be(data, record)?;
        let _encoding_id = u16_be(data, record + 2)?;
        let language_id = u16_be(data, record + 4)?;
        let name_id = u16_be(data, record + 6)?;
        let length = u16_be(data, record + 8)? as usize;
        let offset = u16_be(data, record + 10)? as usize;
        let start = string_offset.checked_add(offset)?;
        let end = start.checked_add(length)?;
        if end > data.len() {
            continue;
        }
        let Some(value) = decode_name(platform_id, &data[start..end]) else {
            continue;
        };
        let rank = name_rank(platform_id, language_id);
        match name_id {
            16 => keep_best(&mut typographic_family, rank, value),
            1 => keep_best(&mut legacy_family, rank, value),
            17 => keep_best(&mut typographic_style, rank, value),
            2 => keep_best(&mut legacy_style, rank, value),
            _ => {}
        }
    }
    let family = typographic_family.or(legacy_family)?.value;
    let style = typographic_style.or(legacy_style).map(|candidate| candidate.value).unwrap_or_default();
    Some((family, style))
}

/// Reads the family and style of one face starting at `base` in an sfnt font.
fn read_face_names(file: &mut File, base: u64) -> Option<(String, String)> {
    let table_count = read_u16_at(file, base + 4)?;
    if table_count == 0 || table_count > 256 {
        return None;
    }
    for index in 0..table_count as u64 {
        let record = base + 12 + index * 16;
        let mut record_bytes = [0u8; 16];
        file.seek(SeekFrom::Start(record)).ok()?;
        file.read_exact(&mut record_bytes).ok()?;
        if &record_bytes[0..4] != b"name" {
            continue;
        }
        let table_offset = u32::from_be_bytes([
            record_bytes[8],
            record_bytes[9],
            record_bytes[10],
            record_bytes[11],
        ]) as u64;
        let table_length = u32::from_be_bytes([
            record_bytes[12],
            record_bytes[13],
            record_bytes[14],
            record_bytes[15],
        ]) as usize;
        if table_length == 0 || table_length > MAX_NAME_TABLE_BYTES {
            return None;
        }
        let mut table = vec![0u8; table_length];
        file.seek(SeekFrom::Start(base + table_offset)).ok()?;
        file.read_exact(&mut table).ok()?;
        return parse_name_table(&table);
    }
    None
}

/// Every face in a font file. A `ttc`/`otc` collection holds several faces; a plain `ttf`/`otf`
/// holds one. Unrelated or broken files simply yield no faces.
fn read_font_faces(path: &Path) -> Vec<(String, String)> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(metadata) = file.metadata() else {
        return Vec::new();
    };
    if metadata.len() < 12 || metadata.len() > MAX_FONT_FILE_BYTES {
        return Vec::new();
    }
    let mut header = [0u8; 12];
    if file.read_exact(&mut header).is_err() {
        return Vec::new();
    }
    let magic = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    let offsets: Vec<u64> = match magic {
        // TrueType collection / OpenType collection.
        0x7474_6366 => {
            let count = u32::from_be_bytes([header[8], header[9], header[10], header[11]]);
            if count == 0 || count > 128 {
                return Vec::new();
            }
            let mut offsets = Vec::with_capacity(count as usize);
            for index in 0..count as u64 {
                match read_u16_at(&mut file, 12 + index * 4) {
                    Some(high) => {
                        let low = read_u16_at(&mut file, 14 + index * 4).unwrap_or(0);
                        offsets.push(((high as u64) << 16) | low as u64);
                    }
                    None => break,
                }
            }
            offsets
        }
        // 0x00010000 (TrueType), "OTTO" (CFF), "true" (legacy Apple).
        0x0001_0000 | 0x4F54_544F | 0x7472_7565 => vec![0],
        _ => Vec::new(),
    };
    let mut faces = Vec::new();
    for offset in offsets {
        if let Some(face) = read_face_names(&mut file, offset) {
            faces.push(face);
        }
    }
    faces
}

fn collect_font_files(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            collect_font_files(&path, depth - 1, out);
        } else if is_font_file(&path) && path.is_file() {
            out.push(path);
        }
    }
}

/// The directories this platform installs fonts into. Missing directories are skipped by the scan.
fn font_directories() -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Some(windows_dir) = std::env::var_os("WINDIR") {
            directories.push(PathBuf::from(windows_dir).join("Fonts"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            directories.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
        if let Some(roaming) = std::env::var_os("APPDATA") {
            directories.push(
                PathBuf::from(roaming)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        directories.push(PathBuf::from("/System/Library/Fonts"));
        directories.push(PathBuf::from("/System/Library/Fonts/Supplemental"));
        directories.push(PathBuf::from("/Library/Fonts"));
        if let Some(home) = std::env::var_os("HOME") {
            directories.push(PathBuf::from(home).join("Library").join("Fonts"));
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            directories.push(home.join(".local").join("share").join("fonts"));
            directories.push(home.join(".fonts"));
        }
        directories.push(PathBuf::from("/usr/share/fonts"));
        directories.push(PathBuf::from("/usr/local/share/fonts"));
        directories.push(PathBuf::from("/usr/share/fonts/truetype"));
        directories.push(PathBuf::from("/usr/share/fonts/opentype"));
        directories.push(PathBuf::from("/usr/share/fonts/X11"));
        directories.push(PathBuf::from("/usr/X11R6/lib/X11/fonts"));
        if let Some(data_dirs) = std::env::var_os("XDG_DATA_DIRS") {
            for entry in std::env::split_paths(&data_dirs) {
                directories.push(entry.join("fonts"));
            }
        }
    }

    directories.sort();
    directories.dedup();
    directories
}

/// Linux and other fontconfig platforms: ask fontconfig for every file it knows about. This is the
/// platform's own database, so it includes fonts outside the standard directories that a
/// hand-written `fonts.conf` adds.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn fontconfig_files() -> Vec<PathBuf> {
    let output = std::process::Command::new("fc-list")
        .arg("--format=%{file}\n")
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut files: Vec<PathBuf> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| is_font_file(path))
        .collect();
    files.sort();
    files.dedup();
    files
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn fontconfig_files() -> Vec<PathBuf> {
    Vec::new()
}

fn clean_family(family: &str) -> Option<String> {
    let trimmed = family.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_FAMILY_CHARS
        || trimmed.starts_with('.')
        || trimmed.chars().any(|ch| ch.is_control())
    {
        return None;
    }
    Some(trimmed.to_string())
}

/// Every installed font family, sorted case-insensitively. Families that only differ by case or by
/// style are merged; the styles are kept so the picker can show what is installed.
pub fn list_system_font_families() -> Vec<SystemFontFamily> {
    let mut files = Vec::new();
    for directory in font_directories() {
        if directory.is_dir() {
            collect_font_files(&directory, MAX_SCAN_DEPTH, &mut files);
        }
    }
    files.extend(fontconfig_files());
    files.sort();
    files.dedup();

    let mut families: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    for path in files {
        for (family, style) in read_font_faces(&path) {
            let Some(family) = clean_family(&family) else {
                continue;
            };
            let style = clean_family(&style).unwrap_or_default();
            let key = family.to_lowercase();
            let entry = families
                .entry(key)
                .or_insert_with(|| (family.clone(), Vec::new()));
            if !style.is_empty() && !entry.1.contains(&style) {
                entry.1.push(style);
            }
        }
    }

    families
        .into_values()
        .map(|(family, mut styles)| {
            styles.sort();
            styles.dedup();
            SystemFontFamily { family, styles }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal sfnt whose `name` table holds the given `(platform, language, name id, text)`
    /// records as Windows-format UTF-16BE strings. Used to prove the parser reads real table
    /// bytes, not file names.
    fn font_with_records(entries: &[(u16, u16, u16, &str)]) -> Vec<u8> {
        fn utf16(text: &str) -> Vec<u8> {
            text.encode_utf16().flat_map(|unit| unit.to_be_bytes()).collect()
        }
        let mut strings = Vec::new();
        let mut records = Vec::new();
        for (platform_id, language_id, name_id, value) in entries {
            let encoded = utf16(value);
            records.extend_from_slice(&platform_id.to_be_bytes());
            records.extend_from_slice(&1u16.to_be_bytes()); // Unicode BMP
            records.extend_from_slice(&language_id.to_be_bytes());
            records.extend_from_slice(&name_id.to_be_bytes());
            records.extend_from_slice(&(encoded.len() as u16).to_be_bytes());
            records.extend_from_slice(&(strings.len() as u16).to_be_bytes());
            strings.extend_from_slice(&encoded);
        }
        let mut name_table = Vec::new();
        name_table.extend_from_slice(&0u16.to_be_bytes()); // format
        name_table.extend_from_slice(&(entries.len() as u16).to_be_bytes());
        name_table.extend_from_slice(&((6 + records.len()) as u16).to_be_bytes());
        name_table.extend_from_slice(&records);
        name_table.extend_from_slice(&strings);

        let mut font = Vec::new();
        font.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        font.extend_from_slice(&1u16.to_be_bytes()); // one table
        font.extend_from_slice(&0u16.to_be_bytes());
        font.extend_from_slice(&0u16.to_be_bytes());
        font.extend_from_slice(&0u16.to_be_bytes());
        // Table directory: tag, checksum, offset, length.
        font.extend_from_slice(b"name");
        font.extend_from_slice(&0u32.to_be_bytes());
        font.extend_from_slice(&(12 + 16).to_be_bytes());
        font.extend_from_slice(&(name_table.len() as u32).to_be_bytes());
        font.extend_from_slice(&name_table);
        font
    }

    /// en-US Windows records for a legacy family/style plus an optional typographic family.
    fn font_with_names(family: &str, style: &str, typographic: Option<&str>) -> Vec<u8> {
        let mut entries: Vec<(u16, u16, u16, &str)> = vec![(3, 0x0409, 1, family), (3, 0x0409, 2, style)];
        if let Some(value) = typographic {
            entries.push((3, 0x0409, 16, value));
        }
        font_with_records(&entries)
    }

    #[test]
    fn reads_typographic_family_and_style_from_a_name_table() {
        let bytes = font_with_names("Arial Bold", "Regular", Some("Arial"));
        let parsed = parse_name_table(&bytes[12 + 16..]).expect("name table");
        assert_eq!(parsed, ("Arial".to_string(), "Regular".to_string()));
    }

    #[test]
    fn falls_back_to_the_legacy_family_when_there_is_no_typographic_name() {
        let bytes = font_with_names("Georgia", "Bold", None);
        let parsed = parse_name_table(&bytes[12 + 16..]).expect("name table");
        assert_eq!(parsed, ("Georgia".to_string(), "Bold".to_string()));
    }

    #[test]
    fn prefers_the_english_name_over_a_localized_one_regardless_of_record_order() {
        // A Japanese face lists its localized family first; the picker must still show the
        // English name every platform's CSS and font pickers use.
        let bytes = font_with_records(&[
            (3, 0x0411, 1, "\u{30e1}\u{30a4}\u{30ea}\u{30aa}"),
            (3, 0x0409, 1, "Meiryo"),
            (3, 0x0409, 2, "Regular"),
        ]);
        let parsed = parse_name_table(&bytes[12 + 16..]).expect("name table");
        assert_eq!(parsed, ("Meiryo".to_string(), "Regular".to_string()));
    }

    #[test]
    fn rejects_empty_and_control_character_families() {
        assert_eq!(clean_family("   "), None);
        assert_eq!(clean_family(".hidden"), None);
        assert_eq!(clean_family("Ariel"), Some("Ariel".to_string()));
    }

    #[test]
    fn reads_every_face_in_a_collection_file() {
        // Two single-face fonts wrapped in a `ttc`: the header lists both face offsets and the
        // scan must yield both families from the one file.
        let first = font_with_names("First Family", "Regular", None);
        let second = font_with_names("Second Family", "Bold", None);
        let mut collection = Vec::new();
        collection.extend_from_slice(&0x7474_6366u32.to_be_bytes()); // "ttcf"
        collection.extend_from_slice(&2u32.to_be_bytes()); // two faces
        let first_offset = 12 + 8; // header + two offsets
        let second_offset = first_offset + first.len() as u32;
        collection.extend_from_slice(&first_offset.to_be_bytes());
        collection.extend_from_slice(&second_offset.to_be_bytes());
        collection.extend_from_slice(&first);
        collection.extend_from_slice(&second);

        let path = std::env::temp_dir().join(format!("cadence-font-test-{}.ttc", std::process::id()));
        std::fs::write(&path, &collection).expect("write collection");
        let faces = read_font_faces(&path);
        let _ = std::fs::remove_file(&path);
        let mut families: Vec<String> = faces.into_iter().map(|(family, _)| family).collect();
        families.sort();
        assert_eq!(families, vec!["First Family".to_string(), "Second Family".to_string()]);
    }

    #[test]
    fn ignores_files_that_are_not_fonts() {
        let path = std::env::temp_dir().join(format!("cadence-font-test-{}.ttf", std::process::id()));
        std::fs::write(&path, b"not a font at all, just some bytes").expect("write junk");
        assert!(read_font_faces(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
