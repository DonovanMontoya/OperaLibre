//! A scan pins its root directory once and reads parsers from opened files.
//! Walking a pathname is discovery, never authorization to reopen it later.
use crate::*;

#[derive(Clone)]
pub(crate) struct ScanRoot {
    path: PathBuf,
    canonical_path: PathBuf,
    directory: Arc<std::fs::File>,
}
impl ScanRoot {
    pub(crate) fn new(path: &FsPath) -> anyhow::Result<Self> {
        let canonical_path = std::fs::canonicalize(path)?;
        #[cfg(unix)]
        let directory = std::fs::File::open(path)?;
        #[cfg(windows)]
        let directory = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(3)
                .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)?
        };
        if !directory.metadata()?.is_dir() {
            anyhow::bail!("scan root is not a directory");
        }
        Ok(Self {
            path: path.to_path_buf(),
            canonical_path,
            directory: Arc::new(directory),
        })
    }
    pub(crate) fn open(&self, path: &FsPath) -> anyhow::Result<(std::fs::File, std::fs::Metadata)> {
        let relative = path
            .strip_prefix(&self.path)
            .or_else(|_| path.strip_prefix(&self.canonical_path))?;
        let components = relative
            .components()
            .map(|part| match part {
                std::path::Component::Normal(name) => Ok(name),
                _ => Err(anyhow::anyhow!("invalid scan path component")),
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        if components.is_empty() {
            anyhow::bail!("scan path must name a file");
        }
        #[cfg(unix)]
        let file = {
            use std::os::fd::{AsRawFd, FromRawFd};
            use std::os::unix::ffi::OsStrExt;
            let mut parent = self.directory.try_clone()?;
            for (i, name) in components.iter().enumerate() {
                let name = std::ffi::CString::new(name.as_bytes())?;
                let flags = libc::O_RDONLY
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | if i + 1 < components.len() {
                        libc::O_DIRECTORY
                    } else {
                        0
                    };
                // Each name is resolved against the already-open parent. No
                // intermediate symlink or exchanged directory can escape it.
                let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
                if fd < 0 {
                    return Err(io::Error::last_os_error().into());
                }
                parent = unsafe { std::fs::File::from_raw_fd(fd) };
            }
            parent
        };
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT,
            };
            // Denying delete sharing keeps every checked ancestor in place
            // until the final file is open. Reparse points are never followed.
            let mut ancestors = vec![self.directory.try_clone()?];
            let mut current = self.path.clone();
            for (i, name) in components.iter().enumerate() {
                current.push(name);
                let next = std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(3)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&current)?;
                let metadata = next.metadata()?;
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                    || (i + 1 < components.len() && !metadata.is_dir())
                {
                    anyhow::bail!("scan path contains a reparse point");
                }
                ancestors.push(next);
            }
            ancestors.pop().unwrap()
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            anyhow::bail!("scan input is not a regular file");
        }
        Ok((file, metadata))
    }
}

pub(crate) fn open_scan_file_in(
    path: &FsPath,
    allowed_roots: &[PathBuf],
) -> anyhow::Result<std::fs::File> {
    allowed_roots
        .iter()
        .find_map(|root| {
            ScanRoot::new(root)
                .ok()?
                .open(path)
                .ok()
                .map(|opened| opened.0)
        })
        .ok_or_else(|| anyhow::anyhow!("scan input is outside an approved root or cannot be read"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn scan_root_rejects_replaced_files_and_ancestors_and_keeps_open_files() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let folder = root.path().join("Book");
        std::fs::create_dir(&folder).unwrap();
        let path = folder.join("audio.mp3");
        std::fs::write(&path, b"inside").unwrap();
        std::fs::write(outside.path().join("audio.mp3"), b"secret").unwrap();
        let scan = ScanRoot::new(root.path()).unwrap();
        let (mut opened, _) = scan.open(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        symlink(outside.path().join("audio.mp3"), &path).unwrap();
        assert!(scan.open(&path).is_err());
        let mut bytes = Vec::new();
        opened.read_to_end(&mut bytes).unwrap();
        assert_eq!(&bytes, b"inside");
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&folder).unwrap();
        symlink(outside.path(), &folder).unwrap();
        assert!(scan.open(&path).is_err());
        assert!(scan.open(&root.path().join("../audio.mp3")).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn scan_root_never_reads_outside_during_directory_exchanges() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let folder = root.path().join("Book");
        let parked = root.path().join("parked");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("audio.mp3"), b"inside").unwrap();
        std::fs::write(outside.path().join("audio.mp3"), b"secret").unwrap();
        let scan = ScanRoot::new(root.path()).unwrap();
        let folder2 = folder.clone();
        let outside_path = outside.path().to_path_buf();
        let worker = std::thread::spawn(move || {
            for _ in 0..1000 {
                std::fs::rename(&folder2, &parked).unwrap();
                symlink(&outside_path, &folder2).unwrap();
                std::fs::remove_file(&folder2).unwrap();
                std::fs::rename(&parked, &folder2).unwrap();
            }
        });
        for _ in 0..1000 {
            if let Ok((mut file, _)) = scan.open(&folder.join("audio.mp3")) {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).unwrap();
                assert_eq!(&bytes, b"inside");
            }
        }
        worker.join().unwrap();
    }
}
