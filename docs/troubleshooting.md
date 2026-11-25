# Troubleshooting

## Database integrity

SQLite databases can become corrupted after a disk-full event, a bad shutdown, or
when the file lives on network storage that does not honour SQLite locking.

### `lens doctor`

`lens doctor` runs `PRAGMA quick_check` against the configured database and reports
corruption as a failure. A healthy database prints `ok`; anything else is listed as a
problem and the command exits non-zero.

### `lens verify --integrity`

`lens verify --integrity` runs the full `PRAGMA integrity_check` and prints every
problem SQLite reports. Use it when `lens doctor` flags corruption or when you suspect
the file was damaged.

```sh
lens doctor
lens verify --integrity
```

If corruption is reported, restore from a backup or export what you can before
recreating the database.

## Exit codes

| Command | Code | Meaning |
| --- | --- | --- |
| `lens doctor` | `0` | All checks passed, including `PRAGMA quick_check`. |
| `lens doctor` | `1` | One or more checks failed (including database corruption). |
| `lens verify` | `0` | Verification passed. |
| `lens verify` | `1` | Verification failed. |
| `lens verify --integrity` | `0` | `PRAGMA integrity_check` returned `ok`. |
| `lens verify --integrity` | `1` | `PRAGMA integrity_check` reported problems (printed to stdout). |
