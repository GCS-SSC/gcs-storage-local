import { access, chmod, chown, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deleteLocalStorageObject,
  LOCAL_FILE_STORAGE_DIR_ENV,
  readLocalStorageObject,
  resolveLocalFileStorageRoot,
  resolveLocalStorageObjectPath,
  writeLocalStorageObject
} from '../../server/local-file-storage'

const originalWorkingDirectory = process.cwd()
const originalConfiguredRoot = process.env[LOCAL_FILE_STORAGE_DIR_ENV]
const temporaryPaths: string[] = []

const createLinkedDirectoryFixture = async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'gcs-storage-root-'))
  const outsideRoot = await mkdtemp(join(tmpdir(), 'gcs-storage-outside-'))
  temporaryPaths.push(storageRoot, outsideRoot)
  process.env[LOCAL_FILE_STORAGE_DIR_ENV] = storageRoot
  await mkdir(join(storageRoot, 'bucket'), { mode: 0o700 })
  await chmod(join(storageRoot, 'bucket'), 0o700)
  await writeFile(join(outsideRoot, 'secret.txt'), 'outside secret')
  await symlink(outsideRoot, join(storageRoot, 'bucket', 'linked'), 'dir')
  return { outsideRoot }
}

const createLinkedFileFixture = async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'gcs-storage-root-'))
  const outsideRoot = await mkdtemp(join(tmpdir(), 'gcs-storage-outside-'))
  temporaryPaths.push(storageRoot, outsideRoot)
  process.env[LOCAL_FILE_STORAGE_DIR_ENV] = storageRoot
  await mkdir(join(storageRoot, 'bucket'), { mode: 0o700 })
  await chmod(join(storageRoot, 'bucket'), 0o700)
  const outsideFile = join(outsideRoot, 'secret.txt')
  await writeFile(outsideFile, 'outside secret')
  await symlink(outsideFile, join(storageRoot, 'bucket', 'linked.txt'), 'file')
  return { outsideFile }
}

const createWritableFileFixture = async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'gcs-storage-writable-file-'))
  temporaryPaths.push(storageRoot)
  process.env[LOCAL_FILE_STORAGE_DIR_ENV] = storageRoot
  await chmod(storageRoot, 0o700)
  const bucketPath = join(storageRoot, 'bucket')
  await mkdir(bucketPath, { mode: 0o700 })
  await chmod(bucketPath, 0o700)
  const objectPath = join(bucketPath, 'object.txt')
  await writeFile(objectPath, 'unsafe original')
  await chmod(objectPath, 0o666)
  return { objectPath }
}

const createReadableFileFixture = async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'gcs-storage-readable-file-'))
  temporaryPaths.push(storageRoot)
  process.env[LOCAL_FILE_STORAGE_DIR_ENV] = storageRoot
  await chmod(storageRoot, 0o700)
  const bucketPath = join(storageRoot, 'bucket')
  await mkdir(bucketPath, { mode: 0o700 })
  await chmod(bucketPath, 0o700)
  const objectPath = join(bucketPath, 'object.txt')
  await writeFile(objectPath, 'readable original')
  await chmod(objectPath, 0o644)
  return { objectPath }
}

afterEach(async () => {
  process.chdir(originalWorkingDirectory)
  if (originalConfiguredRoot === undefined) {
    delete process.env[LOCAL_FILE_STORAGE_DIR_ENV]
  } else {
    process.env[LOCAL_FILE_STORAGE_DIR_ENV] = originalConfiguredRoot
  }

  for (const temporaryPath of temporaryPaths.splice(0)) {
    await chmod(temporaryPath, 0o700).catch(() => {})
    await rm(temporaryPath, { recursive: true, force: true })
  }
})

describe('local file storage paths', () => {
  it('uses the existing cwd-relative data root by default', () => {
    delete process.env[LOCAL_FILE_STORAGE_DIR_ENV]

    expect(resolveLocalFileStorageRoot()).toBe(join(process.cwd(), '.data', 'files'))
  })

  it('writes beneath an external configured root while cwd is read-only', async () => {
    const readOnlyWorkingDirectory = await mkdtemp(join(tmpdir(), 'gcs-read-only-cwd-'))
    const externalStorageRoot = await mkdtemp(join(tmpdir(), 'gcs-external-storage-'))
    temporaryPaths.push(readOnlyWorkingDirectory, externalStorageRoot)
    process.env[LOCAL_FILE_STORAGE_DIR_ENV] = externalStorageRoot
    process.chdir(readOnlyWorkingDirectory)
    await chmod(readOnlyWorkingDirectory, 0o555)

    await writeLocalStorageObject(
      'local-document-templates',
      'document-templates/31/agreement.docx',
      Buffer.from('portable template')
    )
    const objectPath = resolveLocalStorageObjectPath(
      'local-document-templates',
      'document-templates/31/agreement.docx'
    )

    expect(objectPath.startsWith(externalStorageRoot)).toBe(true)
    await expect(readFile(objectPath, 'utf8')).resolves.toBe('portable template')
  })

  it('creates the storage tree with service-private permissions under a permissive umask', async () => {
    const parentPath = await mkdtemp(join(tmpdir(), 'gcs-private-storage-parent-'))
    temporaryPaths.push(parentPath)
    const storageRoot = join(parentPath, 'storage')
    process.env[LOCAL_FILE_STORAGE_DIR_ENV] = storageRoot
    const previousUmask = process.umask(0o000)

    try {
      await writeLocalStorageObject(
        'bucket',
        'nested/agreement.docx',
        Buffer.from('private template')
      )
    } finally {
      process.umask(previousUmask)
    }

    const paths = [
      storageRoot,
      join(storageRoot, 'bucket'),
      join(storageRoot, 'bucket', 'nested')
    ]
    for (const path of paths) {
      const pathStats = await stat(path)
      expect(pathStats.mode & 0o777).toBe(0o700)
      if (process.getuid !== undefined) {
        expect(pathStats.uid).toBe(process.getuid())
      }
    }
    const fileStats = await stat(join(storageRoot, 'bucket', 'nested', 'agreement.docx'))
    expect(fileStats.mode & 0o777).toBe(0o600)
  })

  it('creates every missing storage component with exact private modes under a restrictive umask', async () => {
    const parentPath = await mkdtemp(join(tmpdir(), 'gcs-restrictive-storage-parent-'))
    temporaryPaths.push(parentPath)
    const storageRoot = join(parentPath, 'first-missing', 'second-missing', 'storage')
    process.env[LOCAL_FILE_STORAGE_DIR_ENV] = storageRoot
    const previousUmask = process.umask(0o777)

    try {
      await writeLocalStorageObject(
        'bucket',
        'nested/agreement.docx',
        Buffer.from('private template')
      )
    } finally {
      process.umask(previousUmask)
    }

    const directoryPaths = [
      join(parentPath, 'first-missing'),
      join(parentPath, 'first-missing', 'second-missing'),
      storageRoot,
      join(storageRoot, 'bucket'),
      join(storageRoot, 'bucket', 'nested')
    ]
    for (const directoryPath of directoryPaths) {
      expect((await stat(directoryPath)).mode & 0o777).toBe(0o700)
    }
    expect((await stat(join(storageRoot, 'bucket', 'nested', 'agreement.docx'))).mode & 0o777)
      .toBe(0o600)
  })

  it('rejects rather than normalizes an existing unsafe storage root on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }

    const storageRoot = await mkdtemp(join(tmpdir(), 'gcs-existing-storage-root-'))
    temporaryPaths.push(storageRoot)
    process.env[LOCAL_FILE_STORAGE_DIR_ENV] = storageRoot
    await chmod(storageRoot, 0o750)

    await expect(writeLocalStorageObject('bucket', 'agreement.docx', Buffer.from('rejected')))
      .rejects.toThrow('Unsafe local storage directory permissions')
    expect((await stat(storageRoot)).mode & 0o777).toBe(0o750)
  })

  it('rejects a configured storage root that is a symbolic link', async () => {
    const linkParent = await mkdtemp(join(tmpdir(), 'gcs-storage-link-parent-'))
    const actualRoot = await mkdtemp(join(tmpdir(), 'gcs-storage-link-target-'))
    temporaryPaths.push(linkParent, actualRoot)
    const linkedRoot = join(linkParent, 'storage')
    await symlink(actualRoot, linkedRoot, 'dir')
    process.env[LOCAL_FILE_STORAGE_DIR_ENV] = linkedRoot

    await expect(writeLocalStorageObject('bucket', 'agreement.docx', Buffer.from('rejected')))
      .rejects.toThrow('Invalid storage object path')
  })

  it('rejects a group-writable storage root on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }

    const storageRoot = await mkdtemp(join(tmpdir(), 'gcs-unsafe-storage-root-'))
    temporaryPaths.push(storageRoot)
    process.env[LOCAL_FILE_STORAGE_DIR_ENV] = storageRoot
    await chmod(storageRoot, 0o770)

    await expect(writeLocalStorageObject('bucket', 'agreement.docx', Buffer.from('rejected')))
      .rejects.toThrow('Unsafe local storage directory permissions')
  })

  it('rejects a group-or-other-readable storage root on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }

    const storageRoot = await mkdtemp(join(tmpdir(), 'gcs-readable-storage-root-'))
    temporaryPaths.push(storageRoot)
    process.env[LOCAL_FILE_STORAGE_DIR_ENV] = storageRoot
    await chmod(storageRoot, 0o755)

    await expect(writeLocalStorageObject('bucket', 'agreement.docx', Buffer.from('rejected')))
      .rejects.toThrow('Unsafe local storage directory permissions')
  })

  it('rejects a storage root beneath a writable non-sticky parent on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }

    const fixtureRoot = await mkdtemp(join(tmpdir(), 'gcs-unsafe-storage-parent-'))
    temporaryPaths.push(fixtureRoot)
    const writableParent = join(fixtureRoot, 'shared')
    await mkdir(writableParent, { mode: 0o700 })
    await chmod(writableParent, 0o777)
    process.env[LOCAL_FILE_STORAGE_DIR_ENV] = join(writableParent, 'storage')

    await expect(writeLocalStorageObject('bucket', 'agreement.docx', Buffer.from('rejected')))
      .rejects.toThrow('Unsafe local storage root namespace permissions')
  })

  it('rejects a group-writable ancestor beneath the storage root on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }

    const storageRoot = await mkdtemp(join(tmpdir(), 'gcs-unsafe-storage-ancestor-'))
    temporaryPaths.push(storageRoot)
    process.env[LOCAL_FILE_STORAGE_DIR_ENV] = storageRoot
    const bucketPath = join(storageRoot, 'bucket')
    await mkdir(bucketPath, { mode: 0o700 })
    await chmod(bucketPath, 0o770)

    await expect(writeLocalStorageObject('bucket', 'nested/agreement.docx', Buffer.from('rejected')))
      .rejects.toThrow('Unsafe local storage directory permissions')
  })

  it('rejects reading a group-or-other-writable final file on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }
    await createWritableFileFixture()

    await expect(readLocalStorageObject('bucket', 'object.txt'))
      .rejects.toThrow('Unsafe local storage file permissions')
  })

  it('rejects deleting a group-or-other-writable final file on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }
    const { objectPath } = await createWritableFileFixture()

    await expect(deleteLocalStorageObject('bucket', 'object.txt'))
      .rejects.toThrow('Unsafe local storage file permissions')
    await expect(readFile(objectPath, 'utf8')).resolves.toBe('unsafe original')
  })

  it('rejects replacing a group-or-other-writable final file on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }
    const { objectPath } = await createWritableFileFixture()

    await expect(writeLocalStorageObject('bucket', 'object.txt', Buffer.from('replacement')))
      .rejects.toThrow('Unsafe local storage file permissions')
    await expect(readFile(objectPath, 'utf8')).resolves.toBe('unsafe original')
    expect((await stat(objectPath)).mode & 0o777).toBe(0o666)
  })

  it('rejects reading a group-or-other-readable final file on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }
    await createReadableFileFixture()

    await expect(readLocalStorageObject('bucket', 'object.txt'))
      .rejects.toThrow('Unsafe local storage file permissions')
  })

  it('rejects deleting a group-or-other-readable final file on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }
    const { objectPath } = await createReadableFileFixture()

    await expect(deleteLocalStorageObject('bucket', 'object.txt'))
      .rejects.toThrow('Unsafe local storage file permissions')
    await expect(readFile(objectPath, 'utf8')).resolves.toBe('readable original')
  })

  it('rejects replacing a group-or-other-readable final file on POSIX', async () => {
    if (process.getuid === undefined) {
      return
    }
    const { objectPath } = await createReadableFileFixture()

    await expect(writeLocalStorageObject('bucket', 'object.txt', Buffer.from('replacement')))
      .rejects.toThrow('Unsafe local storage file permissions')
    await expect(readFile(objectPath, 'utf8')).resolves.toBe('readable original')
  })

  it.skipIf(process.getuid === undefined || process.getuid() !== 0)(
    'rejects a final file owned by another account when the POSIX fixture can change ownership',
    async () => {
      const { objectPath } = await createWritableFileFixture()
      await chmod(objectPath, 0o600)
      const objectStats = await stat(objectPath)
      await chown(objectPath, 1, objectStats.gid)

      await expect(readLocalStorageObject('bucket', 'object.txt'))
        .rejects.toThrow('Unsafe local storage file permissions')
    }
  )

  it('rejects object traversal outside the configured root', () => {
    expect(() => resolveLocalStorageObjectPath('local-document-templates', '../secret.docx'))
      .toThrow('Invalid object key')
  })

  it.each([
    '../outside',
    'nested/../../outside',
    '/absolute-bucket',
    'C:\\absolute-bucket'
  ])('rejects malformed bucket %s independently of the object key', (bucket) => {
    expect(() => resolveLocalStorageObjectPath(bucket, 'agreement.docx'))
      .toThrow('Invalid bucket')
  })

  it.each([
    '../secret.docx',
    'nested/../../secret.docx',
    '/absolute-secret.docx',
    'C:\\absolute-secret.docx'
  ])('rejects malformed object key %s independently of the bucket', (objectKey) => {
    expect(() => resolveLocalStorageObjectPath('local-document-templates', objectKey))
      .toThrow('Invalid object key')
  })

  it('allows ordinary path segments containing consecutive periods', () => {
    const path = resolveLocalStorageObjectPath(
      'local..document-templates',
      'documents/draft..final.docx'
    )

    expect(path).toBe(resolve(
      process.cwd(),
      '.data/files/local..document-templates/documents/draft..final.docx'
    ))
  })

  it('rejects reads through an existing ancestor symlink', async () => {
    const { outsideRoot } = await createLinkedDirectoryFixture()

    await expect(readLocalStorageObject('bucket', 'linked/secret.txt'))
      .rejects.toThrow('Invalid storage object path')
    await expect(readFile(join(outsideRoot, 'secret.txt'), 'utf8')).resolves.toBe('outside secret')
  })

  it('rejects deletes through an existing ancestor symlink', async () => {
    const { outsideRoot } = await createLinkedDirectoryFixture()

    await expect(deleteLocalStorageObject('bucket', 'linked/secret.txt'))
      .rejects.toThrow('Invalid storage object path')
    await expect(readFile(join(outsideRoot, 'secret.txt'), 'utf8')).resolves.toBe('outside secret')
  })

  it('rejects writes through an existing ancestor symlink', async () => {
    const { outsideRoot } = await createLinkedDirectoryFixture()

    await expect(writeLocalStorageObject('bucket', 'linked/new.txt', Buffer.from('escaped')))
      .rejects.toThrow('Invalid storage object path')
    await expect(access(join(outsideRoot, 'new.txt'))).rejects.toThrow()
  })

  it('rejects reading a final-component symlink', async () => {
    const { outsideFile } = await createLinkedFileFixture()

    await expect(readLocalStorageObject('bucket', 'linked.txt'))
      .rejects.toThrow('Invalid storage object path')
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside secret')
  })

  it('rejects deleting a final-component symlink', async () => {
    const { outsideFile } = await createLinkedFileFixture()

    await expect(deleteLocalStorageObject('bucket', 'linked.txt'))
      .rejects.toThrow('Invalid storage object path')
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside secret')
  })

  it('rejects replacing a final-component symlink', async () => {
    const { outsideFile } = await createLinkedFileFixture()

    await expect(writeLocalStorageObject('bucket', 'linked.txt', Buffer.from('replacement')))
      .rejects.toThrow('Invalid storage object path')
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside secret')
  })
})

