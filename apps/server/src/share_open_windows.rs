//! Windows selected-source opens deliberately remain unavailable.
//!
//! A final-component FILE_FLAG_OPEN_REPARSE_POINT or a canonicalize/open pair
//! does not establish ancestor confinement. NtCreateFile's RootDirectory is a
//! viable relative-handle primitive, but enabling it requires a validated root
//! acquisition/walk and adversarial Windows tests for junction/reparse mutation,
//! hard-link aliases, file/volume identity, ADS and device namespaces. The open
//! must return the same verified handle, never reopen its path for streaming.
//!
//! Do not infer metadata stability from share-deny flags: CreateFileW documents
//! that attribute/EA access is unaffected by sharing modes. FILE_LINK_INFORMATION
//! also documents no specific required access rights. A link-count sample or a
//! final normalized-name sample is not, alone, a race-safety argument.
//!
//! Primary contracts checked:
//! - https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile
//! - https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
//! - https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_link_information
//!
//! These tests protect the current denial boundary, not an implemented secure
//! Windows opener. Enabling support needs positive handle-relative and namespace
//! mutation tests on Windows; the Unix openat implementation is independent.

use std::{fs::File, path::Path};

pub(super) fn open(_path: &Path, _root: &Path) -> anyhow::Result<File> {
    anyhow::bail!(
        "Selected-asset sharing on Windows is unavailable: ancestor-handle confinement has not been validated."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_selected_open_remains_disabled_even_for_regular_nested_files() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("books");
        std::fs::create_dir(&nested).unwrap();
        let path = nested.join("selected.epub");
        std::fs::write(&path, b"selected fixture bytes").unwrap();
        let error = open(&path, root.path()).unwrap_err();
        assert!(error.to_string().contains("ancestor-handle confinement"));
        assert!(crate::share::open_share_file(&path, root.path()).is_err());
    }

    #[test]
    fn windows_selected_open_denies_existing_hard_link_alias() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("library");
        std::fs::create_dir(&root).unwrap();
        let outside = fixture.path().join("outside-private.epub");
        std::fs::write(&outside, b"must not be shared").unwrap();
        let alias = root.join("selected.epub");
        std::fs::hard_link(&outside, &alias).unwrap();
        assert!(crate::share::open_share_file(&alias, &root).is_err());
    }

    #[test]
    fn windows_selected_open_denies_stream_device_unc_and_parent_spellings() {
        let root = Path::new(r"C:\library");
        for path in [
            r"C:\library\book.epub:private",
            r"C:\library\book.epub::$DATA",
            r"C:\library\..\outside.epub",
            r"C:\library-other\book.epub",
            r"C:library\book.epub",
            r"\\server\library\book.epub",
            r"\\?\UNC\server\library\book.epub",
            r"\\.\GLOBALROOT\Device\HarddiskVolume1\private.epub",
            r"\\?\C:\library\NUL",
        ] {
            assert!(crate::share::open_share_file(Path::new(path), root).is_err());
        }
    }
}
