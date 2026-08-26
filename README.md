# GCS-SSC Local Storage Provider

Private local-filesystem storage provider for GCS-SSC. The extension implements only the host file-storage adapter; attachment metadata, target ownership, authorization, lifecycle enforcement, and APIs remain host-owned.

Objects are stored below `GCS_LOCAL_FILE_STORAGE_DIR`, or `.data/files` relative to the service working directory when the variable is unset. The storage tree must be private to the service identity. On POSIX, the adapter enforces ownership and modes (`0700` directories, `0600` files), rejects traversal and symbolic links, and verifies that writable ancestors cannot replace the configured root. On platforms without `process.getuid`, deployment ACLs must enforce the equivalent boundary.

The provider has no agency secrets, configuration UI, or custom attachment metadata.

```bash
bun run typecheck
bun run test:unit
bun run test:coverage
```
