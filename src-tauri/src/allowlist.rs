//! Path containment and allowlist enforcement for `cadence-media` and filesystem commands.
//!
//! Mirrors the exact containment rules in `src/main/media/allowlist.ts`:
//! - Only directories explicitly added to the user's music library (`allowed_roots`), specific
//!   audio files opened directly from the shell (`allowed_files`), or the app's own artwork cache
//!   directory (`artwork_dir`) may be read.
//! - Rejects NUL bytes, Windows drive-relative paths (`C:track.flac`), sibling-prefix escapes
//!   (`Music` vs `Music2`), `..` parent traversal, and cross-drive / cross-UNC resolution.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::RwLock;

pub struct MediaAllowlist {
    artwork_dir: PathBuf,
    roots: RwLock<HashSet<PathBuf>>,
    files: RwLock<HashSet<PathBuf>>,
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
                        prefix_key(rp) == prefix_key(cp)
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
        }
    }

    pub fn artwork_dir(&self) -> &Path {
        &self.artwork_dir
    }

    pub fn set_roots(&self, roots: impl IntoIterator<Item = String>) {
        if let Ok(mut guard) = self.roots.write() {
            guard.clear();
            for root in roots {
                if let Some(resolved) = resolve_real_or_lexical(Path::new(&root)) {
                    guard.insert(resolved);
                }
            }
        }
    }

    pub fn add_root(&self, root: &Path) {
        if let Some(resolved) = resolve_real_or_lexical(root) {
            if let Ok(mut guard) = self.roots.write() {
                guard.insert(resolved);
            }
        }
    }

    pub fn add_file(&self, file_path: &Path) {
        if let Some(resolved) = resolve_real_or_lexical(file_path) {
            if let Ok(mut guard) = self.files.write() {
                guard.insert(resolved);
            }
        }
    }

    pub fn resolve_allowed_media(&self, candidate_raw: &str) -> Option<PathBuf> {
        if candidate_raw.is_empty() || candidate_raw.contains('\0') {
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
        None
    }

    pub fn resolve_contained_artwork(&self, target_raw: &str) -> Option<PathBuf> {
        if target_raw.is_empty()
            || target_raw.contains('\0')
            || has_windows_drive_relative(target_raw)
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
