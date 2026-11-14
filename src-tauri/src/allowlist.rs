//! Path containment and allowlist enforcement for `cadence-media` and filesystem commands.
//!
//! Mirrors the exact containment rules in `src/main/media/allowlist.ts`:
//! - Only directories explicitly added to the user's music library (`allowed_roots`), specific
//!   audio files opened directly from the shell (`allowed_files`), Android granted content URIs /
//!   MediaStore / SAF trees, or the app's own artwork cache directory (`artwork_dir`) may be read.
//! - Rejects NUL bytes, Windows drive-relative paths (`C:track.flac`), sibling-prefix escapes
//!   (`Music` vs `Music2`), `..` parent traversal, and cross-drive / cross-UNC resolution.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::RwLock;

use percent_encoding::percent_decode_str;

pub struct MediaAllowlist {
    artwork_dir: PathBuf,
    roots: RwLock<HashSet<PathBuf>>,
    files: RwLock<HashSet<PathBuf>>,
    content_roots: RwLock<HashSet<String>>,
    content_files: RwLock<HashSet<String>>,
}

pub fn is_content_or_mediastore_uri(raw: &str) -> bool {
    raw.starts_with("content://") || raw.starts_with("mediastore://")
}

fn has_safe_uri_segments(raw: &str) -> bool {
    if raw.is_empty() || raw.contains('\0') {
        return false;
    }
    let decoded = percent_decode_str(raw).decode_utf8_lossy();
    !decoded.contains('\0')
        && !decoded
            .split(['/', '\\'])
            .any(|segment| segment == "..")
}

fn is_content_uri_under_root(root: &str, candidate: &str) -> bool {
    if !has_safe_uri_segments(candidate) || !candidate.starts_with("content://") {
        return false;
    }
    if root == "mediastore://audio" {
        return candidate.starts_with("content://media/")
            && candidate.contains("/audio/media/");
    }
    if !root.starts_with("content://") {
        return false;
    }
    let normalized_root = root.trim_end_matches('/');
    candidate == normalized_root
        || candidate
            .strip_prefix(normalized_root)
            .map(|rest| rest.starts_with("/document/"))
            .unwrap_or(false)
}

fn has_windows_drive_relative(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return bytes.len() == 2 || (bytes[2] != b'\\' && bytes[2] != b'/');
    }
    false
}

pub fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let Some(s) = path.to_str() else {
        return path;
    };
    if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\").or_else(|| s.strip_prefix("\\\\?\\unc\\")) {
        return PathBuf::from(format!("\\\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix("\\\\?\\") {
        return PathBuf::from(rest);
    }
    path
}

pub fn normalize_lexical(path: &Path) -> Option<PathBuf> {
    let raw = path.to_str()?;
    if raw.is_empty() || raw.contains('\0') || has_windows_drive_relative(raw) {
        return None;
    }

    let cleaned = strip_verbatim_prefix(path.to_path_buf());
    let mut out = PathBuf::new();
    let mut has_root = false;

    for component in cleaned.components() {
        match component {
            Component::Prefix(prefix) => {
                out.push(prefix.as_os_str());
            }
            Component::RootDir => {
                out.push(component.as_os_str());
                has_root = true;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() && !has_root {
                    return None;
                }
            }
            Component::Normal(part) => {
                out.push(part);
            }
        }
    }

    if !has_root {
        return None;
    }
    Some(out)
}

pub fn resolve_real_or_lexical(path: &Path) -> Option<PathBuf> {
    let lexical = normalize_lexical(path)?;
    if let Ok(canon) = std::fs::canonicalize(&lexical) {
        return Some(strip_verbatim_prefix(canon));
    }
    Some(lexical)
}

fn prefix_key(prefix: Prefix<'_>) -> String {
    match prefix {
        Prefix::Disk(d) | Prefix::VerbatimDisk(d) => {
            format!("disk:{}", (d as char).to_ascii_lowercase())
        }
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => format!(
            "unc:{}/{}",
            server.to_string_lossy().to_lowercase(),
            share.to_string_lossy().to_lowercase()
        ),
        other => format!("other:{:?}", other),
    }
}

pub fn is_path_inside_resolved(root: &Path, candidate: &Path) -> bool {
    let mut root_comps = root.components();
    let mut cand_comps = candidate.components();

    loop {
        match (root_comps.next(), cand_comps.next()) {
            (None, _) => return true,
            (Some(_), None) => return false,
            (Some(rc), Some(cc)) => {
                let equal = match (rc, cc) {
                    (Component::Prefix(rp), Component::Prefix(cp)) => {
                        prefix_key(rp.kind()) == prefix_key(cp.kind())
                    }
                    (Component::RootDir, Component::RootDir) => true,
                    (Component::Normal(rn), Component::Normal(cn)) => {
                        if cfg!(windows) {
                            rn.to_string_lossy().to_lowercase()
                                == cn.to_string_lossy().to_lowercase()
                        } else {
                            rn == cn
                        }
                    }
                    _ => false,
                };
                if !equal {
                    return false;
                }
            }
        }
    }
}

impl MediaAllowlist {
    pub fn new(artwork_dir: PathBuf) -> Self {
        let normalized_art = resolve_real_or_lexical(&artwork_dir).unwrap_or(artwork_dir);
        Self {
            artwork_dir: normalized_art,
            roots: RwLock::new(HashSet::new()),
            files: RwLock::new(HashSet::new()),
            content_roots: RwLock::new(HashSet::new()),
            content_files: RwLock::new(HashSet::new()),
        }
    }

    pub fn artwork_dir(&self) -> &Path {
        &self.artwork_dir
    }

    pub fn set_roots(&self, roots: impl IntoIterator<Item = String>) {
        let mut fs_roots = Vec::new();
        let mut uri_roots = Vec::new();
        for root in roots {
            if is_content_or_mediastore_uri(&root) {
                if has_safe_uri_segments(&root) {
                    uri_roots.push(root);
                }
            } else if let Some(resolved) = resolve_real_or_lexical(Path::new(&root)) {
                fs_roots.push(resolved);
            }
        }

        if let Ok(mut guard) = self.roots.write() {
            guard.clear();
            for r in fs_roots {
                guard.insert(r);
            }
        }
        if let Ok(mut guard) = self.content_roots.write() {
            guard.clear();
            for u in uri_roots {
                guard.insert(u);
            }
        }
    }

    pub fn add_root(&self, root: &Path) {
        if let Some(raw) = root.to_str() {
            if is_content_or_mediastore_uri(raw) {
                self.add_content_root(raw);
                return;
            }
        }
        if let Some(resolved) = resolve_real_or_lexical(root) {
            if let Ok(mut guard) = self.roots.write() {
                guard.insert(resolved);
            }
        }
    }

    pub fn add_content_root(&self, root_uri: &str) {
        if is_content_or_mediastore_uri(root_uri) && has_safe_uri_segments(root_uri) {
            if let Ok(mut guard) = self.content_roots.write() {
                guard.insert(root_uri.to_string());
            }
        }
    }

    pub fn add_file(&self, file_path: &Path) {
        if let Some(raw) = file_path.to_str() {
            if is_content_or_mediastore_uri(raw) {
                self.add_content_file(raw);
                return;
            }
        }
        if let Some(resolved) = resolve_real_or_lexical(file_path) {
            if let Ok(mut guard) = self.files.write() {
                guard.insert(resolved);
            }
        }
    }

    pub fn add_content_file(&self, file_uri: &str) {
        if file_uri.starts_with("content://") && has_safe_uri_segments(file_uri) {
            if let Ok(mut guard) = self.content_files.write() {
                guard.insert(file_uri.to_string());
            }
        }
    }

    pub fn is_allowed_content_uri(&self, candidate: &str) -> bool {
        if !candidate.starts_with("content://") || !has_safe_uri_segments(candidate) {
            return false;
        }
        if let Ok(files) = self.content_files.read() {
            if files.contains(candidate) {
                return true;
            }
        }
        if let Ok(roots) = self.content_roots.read() {
            for root in roots.iter() {
                if is_content_uri_under_root(root, candidate) {
                    return true;
                }
            }
        }
        false
    }

    pub fn resolve_allowed_media(&self, candidate_raw: &str) -> Option<PathBuf> {
        if candidate_raw.is_empty()
            || candidate_raw.contains('\0')
            || is_content_or_mediastore_uri(candidate_raw)
        {
            return None;
        }
        let candidate = resolve_real_or_lexical(Path::new(candidate_raw))?;

        if let Ok(files) = self.files.read() {
            for allowed in files.iter() {
                if is_path_inside_resolved(allowed, &candidate)
                    && is_path_inside_resolved(&candidate, allowed)
                {
                    return Some(candidate);
                }
            }
        }

        if let Ok(roots) = self.roots.read() {
            for root in roots.iter() {
                if is_path_inside_resolved(root, &candidate) {
                    return Some(candidate);
                }
            }
        }

        // On Android with MediaStore (`mediastore://audio`) or SAF roots, scanned files that live
        // in readable external shared storage (`/storage/...`) are registered in `files` when
        // walked; check resolved filesystem files as well.
        None
    }

    pub fn resolve_contained_artwork(&self, target_raw: &str) -> Option<PathBuf> {
        if target_raw.is_empty()
            || target_raw.contains('\0')
            || has_windows_drive_relative(target_raw)
            || is_content_or_mediastore_uri(target_raw)
        {
            return None;
        }
        let target_path = Path::new(target_raw);
        let joined = if target_path.is_absolute() {
            target_path.to_path_buf()
        } else {
            self.artwork_dir.join(target_path)
        };
        let resolved = resolve_real_or_lexical(&joined)?;
        let art_root = resolve_real_or_lexical(&self.artwork_dir)
            .unwrap_or_else(|| self.artwork_dir.clone());
        if is_path_inside_resolved(&art_root, &resolved) {
            Some(resolved)
        } else {
            None
        }
    }
}
