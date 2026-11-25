//! SQLite-backed store for lens.
//!
//! Provides connection setup, migrations, and integrity checking helpers used
//! by `lens doctor` (quick check) and `lens verify --integrity` (full check).

use rusqlite::{Connection, OpenFlags};
use std::path::Path;

/// Result of an integrity check against a SQLite database file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrityReport {
    /// Whether the database passed the check.
    pub ok: bool,
    /// Individual problems reported by SQLite (empty when `ok` is true).
    pub problems: Vec<String>,
}

impl IntegrityReport {
    fn from_rows(rows: Vec<String>) -> Self {
        // SQLite returns a single row containing "ok" when the database is
        // healthy. Anything else is a problem worth surfacing.
        let problems: Vec<String> = rows
            .into_iter()
            .filter(|row| row.trim() != "ok")
            .collect();
        IntegrityReport {
            ok: problems.is_empty(),
            problems,
        }
    }
}

/// Open a read-only connection to the database at `path`.
fn open_readonly(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
}

/// Run `PRAGMA quick_check` against the database at `path`.
///
/// Used by `lens doctor` to cheaply detect corruption.
pub fn quick_check(path: &Path) -> rusqlite::Result<IntegrityReport> {
    let conn = open_readonly(path)?;
    let mut stmt = conn.prepare("PRAGMA quick_check")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(IntegrityReport::from_rows(rows))
}

/// Run the full `PRAGMA integrity_check` against the database at `path`.
///
/// Used by `lens verify --integrity` to enumerate all problems found.
pub fn integrity_check(path: &Path) -> rusqlite::Result<IntegrityReport> {
    let conn = open_readonly(path)?;
    let mut stmt = conn.prepare("PRAGMA integrity_check")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(IntegrityReport::from_rows(rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture_db(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("fixture.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\n             INSERT INTO t (v) VALUES ('a'), ('b'), ('c');",
        )
        .unwrap();
        path
    }

    #[test]
    fn healthy_db_passes_checks() {
        let dir = std::env::temp_dir().join(format!("lens-integrity-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = fixture_db(&dir);

        assert!(quick_check(&path).unwrap().ok);
        assert!(integrity_check(&path).unwrap().ok);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupted_copy_fails_checks() {
        let dir = std::env::temp_dir().join(format!("lens-integrity-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = fixture_db(&dir);

        // Deliberately corrupt a copy of the fixture database by overwriting
        // bytes in the middle of the file.
        let corrupt = dir.join("corrupt.db");
        std::fs::copy(&path, &corrupt).unwrap();
        {
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .open(&corrupt)
                .unwrap();
            use std::io::Seek;
            f.seek(std::io::SeekFrom::Start(4096)).unwrap();
            f.write_all(&[0xFF; 512]).unwrap();
        }

        let report = integrity_check(&corrupt).unwrap();
        assert!(!report.ok, "expected corruption to be detected");
        assert!(!report.problems.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
}
