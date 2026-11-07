use std::{
    fs::{self, OpenOptions},
    io,
    path::Path,
};

const COMPLETED: &str = ".completed";
const RECOVERY: [&str; 5] = [
    "data",
    "restore-required",
    "restore-pending",
    "failed-data",
    "failed-data.partial",
];

/// Reserve a fresh generation so a timestamp collision cannot reuse a
/// completion marker from an earlier transaction.
pub fn create_generation(backup: &Path) -> io::Result<()> {
    fs::create_dir_all(backup.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
    fs::create_dir(backup)
}

/// Called only after success. Callers log errors without failing the update.
pub fn complete_and_prune(backup: &Path) -> io::Result<()> {
    let backups = backup.parent().ok_or(io::ErrorKind::InvalidInput)?;
    // A first install has no previous component to save. An empty generation
    // must not displace the useful backup left by a preceding removal.
    if fs::read_dir(backup)?.next().is_none() {
        fs::remove_dir(backup)?;
        return prune(backups);
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(backup.join(COMPLETED))?
        .sync_all()?;
    prune(backups)
}

fn generation(name: &str) -> Option<(usize, u128)> {
    let (group, timestamp) = if let Some(timestamp) = name.strip_suffix("-frontend") {
        (1, timestamp)
    } else if let Some(timestamp) = name.strip_suffix("-readalong-sync") {
        (2, timestamp)
    } else {
        (0, name)
    };
    if timestamp.is_empty() || !timestamp.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((group, timestamp.parse().ok()?))
}

fn eligible(backup: &Path) -> io::Result<bool> {
    // Even dangling symlinks and unreadable recovery paths must protect a
    // generation. Never follow a directory or marker symlink while pruning.
    if !fs::symlink_metadata(backup)?.is_dir() {
        return Ok(false);
    }
    for name in RECOVERY {
        match fs::symlink_metadata(backup.join(name)) {
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    match fs::symlink_metadata(backup.join(COMPLETED)) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn prune(backups: &Path) -> io::Result<()> {
    let mut completed = Vec::new();
    for entry in fs::read_dir(backups)? {
        let entry = entry?;
        let Some((group, timestamp)) = entry.file_name().to_str().and_then(generation) else {
            continue;
        };
        if eligible(&entry.path())? {
            completed.push((group, timestamp, entry.path()));
        }
    }
    completed.sort();
    let mut latest = [None; 3];
    for (group, timestamp, _) in &completed {
        latest[*group] = Some(*timestamp);
    }
    for (group, timestamp, backup) in completed {
        if Some(timestamp) < latest[group] && eligible(&backup)? {
            fs::remove_dir_all(backup)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "operalibre-backup-retention-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        root
    }

    fn completed(root: &Path, name: &str) -> std::path::PathBuf {
        let backup = root.join(name);
        create_generation(&backup).unwrap();
        fs::write(backup.join(COMPLETED), b"").unwrap();
        fs::write(backup.join("previous-files"), b"old build").unwrap();
        backup
    }

    #[test]
    fn retains_latest_per_component_and_all_recovery_material() {
        let root = scratch();
        for suffix in ["", "-frontend", "-readalong-sync"] {
            for timestamp in [2, 9, 10] {
                completed(&root, &format!("{timestamp}{suffix}"));
            }
            for (index, recovery) in RECOVERY.iter().enumerate() {
                let backup = completed(&root, &format!("{}{suffix}", index + 20));
                fs::create_dir(backup.join(recovery)).unwrap();
                fs::write(backup.join(recovery).join("keep"), b"owner recovery").unwrap();
            }
            for name in ["1", "99"] {
                create_generation(&root.join(format!("{name}{suffix}"))).unwrap();
            }
        }
        completed(&root, "unknown-backup");
        let current = root.join("11");
        create_generation(&current).unwrap();
        fs::write(current.join("previous-files"), b"old build").unwrap();
        complete_and_prune(&current).unwrap();
        prune(&root).unwrap();
        for suffix in ["", "-frontend", "-readalong-sync"] {
            for timestamp in [2, 9] {
                assert!(!root.join(format!("{timestamp}{suffix}")).exists());
            }
            assert_eq!(
                root.join(format!("10{suffix}")).exists(),
                !suffix.is_empty()
            );
            for (index, recovery) in RECOVERY.iter().enumerate() {
                assert_eq!(
                    fs::read(root.join(format!("{}{suffix}/{recovery}/keep", index + 20))).unwrap(),
                    b"owner recovery"
                );
            }
            for name in ["1", "99"] {
                assert!(root.join(format!("{name}{suffix}")).is_dir());
            }
        }
        assert!(current.join(COMPLETED).is_file());
        assert!(root.join("unknown-backup/previous-files").is_file());
        assert!(create_generation(&current).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_initial_install_keeps_the_last_actual_backup() {
        let root = scratch();
        let previous = completed(&root, "1-readalong-sync");
        let initial = root.join("2-readalong-sync");
        create_generation(&initial).unwrap();
        complete_and_prune(&initial).unwrap();
        assert!(!initial.exists());
        assert_eq!(
            fs::read(previous.join("previous-files")).unwrap(),
            b"old build"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_never_authorize_deletion_or_hide_recovery_material() {
        use std::os::unix::fs::symlink;
        let root = scratch();
        let external = completed(&root, "external");
        symlink(&external, root.join("1")).unwrap();
        let marker_link = completed(&root, "2");
        fs::remove_file(marker_link.join(COMPLETED)).unwrap();
        symlink(external.join(COMPLETED), marker_link.join(COMPLETED)).unwrap();
        let recovery_link = completed(&root, "3");
        symlink("missing", recovery_link.join("failed-data")).unwrap();
        let current = root.join("4");
        create_generation(&current).unwrap();
        fs::write(current.join("previous-files"), b"old build").unwrap();
        complete_and_prune(&current).unwrap();
        for backup in [external, marker_link, recovery_link] {
            assert!(backup.join("previous-files").is_file());
        }
        assert!(root.join("1").is_symlink());
        fs::remove_dir_all(root).unwrap();
    }
}
