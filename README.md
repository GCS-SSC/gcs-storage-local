# GCS-SSC Local Storage Provider

Private local-filesystem storage provider for GCS-SSC. The extension implements only the host file-storage adapter; attachment metadata, target ownership, authorization, lifecycle enforcement, and APIs remain host-owned.

Objects are stored below `GCS_LOCAL_FILE_STORAGE_DIR`, or `.data/files` relative to the service working directory when the variable is unset. The storage tree must be private to the service identity. On POSIX, the adapter enforces ownership and modes (`0700` directories, `0600` files), rejects traversal and symbolic links, and verifies that writable ancestors cannot replace the configured root. On platforms without `process.getuid`, deployment ACLs must enforce the equivalent boundary.

The provider has no agency secrets, configuration UI, or custom attachment metadata.

```bash
bun run typecheck
bun run test:unit
bun run test:coverage
```

## Audit ownership

The extension creates no dedicated database tables. Local objects are represented by host attachment metadata, whose ownership follows the attached entity. Shared host storage/configuration records retain host audit rules.

The manifest targets SDK 0.3.2 and explicitly declares its dedicated tables (an empty
list when there are none). Extension migration journals remain global infrastructure.

Run `bun run test:audit` from this extension inside a GCS-SSC host checkout with
`tooling/gcs-ssc` available. The extension owns its concrete fixtures; the private
host adapter exercises the real audit migrations, declaration publication, row
triggers, both ownership interpreters, rollback and immutable historical audiences.
These reduced-schema ownership fixtures complement the extension’s normal tests.
Set `AUDIT_EXTENSION_POSTGRES_URL` to a disposable PostgreSQL database URL ending
in `_test` to run the same suite on PostgreSQL; the adapter creates and removes an
isolated database. Without that variable, the suite uses in-memory PGlite.
