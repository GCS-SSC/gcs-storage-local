import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { nanoid } from 'nanoid'

/**
 * Local storage trusts mutations made by the service identity. On POSIX, this
 * module validates the namespace leading to the configured root plus ownership
 * and private access permissions for the root and its descendants. On platforms
 * without `process.getuid` (including Windows), operators must use ACLs to
 * restrict the storage tree and its ancestor namespace to the service identity,
 * including delete-child and rename rights that could replace the root entry.
 */
export const LOCAL_FILE_STORAGE_DIR_ENV = 'GCS_LOCAL_FILE_STORAGE_DIR'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const GROUP_OR_OTHER_ACCESS_MASK = 0o077
const GROUP_OR_OTHER_WRITE_MASK = 0o022
const STICKY_BIT_MASK = 0o1000

/**
 * Resolves the root used by the local attachment provider.
 *
 * @returns Absolute local attachment storage root.
 */
export const resolveLocalFileStorageRoot = (): string => {
  const configuredRoot = process.env[LOCAL_FILE_STORAGE_DIR_ENV]
  if (configuredRoot !== undefined && configuredRoot.trim().length > 0) {
    return resolve(configuredRoot.trim())
  }

  return resolve(process.cwd(), '.data', 'files')
}

const hasTraversalSegment = (value: string): boolean =>
  value.split(/[\\/]+/).some(segment => segment === '..')

/**
 * Checks whether a resolved target escapes its trusted root.
 *
 * @param root - Trusted storage root.
 * @param target - Resolved path to inspect.
 * @returns Whether the target is outside the root.
 */
const isOutsideRoot = (root: string, target: string): boolean => {
  const relativePath = relative(root, target)
  return relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
}

/**
 * Resolves a user-controlled path segment beneath a trusted root.
 *
 * @param root - Trusted parent path.
 * @param value - Relative bucket or object-key value.
 * @param label - Value label used in validation errors.
 * @returns Contained absolute path.
 */
const resolveContainedStoragePath = (root: string, value: string, label: 'bucket' | 'object key'): string => {
  if (
    value.length === 0
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || hasTraversalSegment(value)
  ) {
    throw new Error(`Invalid ${label}`)
  }

  const target = resolve(root, value)
  if (isOutsideRoot(root, target)) {
    throw new Error(`Invalid ${label}`)
  }
  return target
}

interface LocalStoragePaths {
  storageRoot: string
  targetPath: string
}

interface LocalStorageFileStats {
  isFile: () => boolean
  isSymbolicLink: () => boolean
  mode: number
  uid: number
}

const invalidStorageObjectPath = (): never => {
  throw new Error('Invalid storage object path')
}

const unsafeStoragePermissions = (): never => {
  throw new Error('Unsafe local storage directory permissions')
}

const unsafeStorageFilePermissions = (): never => {
  throw new Error('Unsafe local storage file permissions')
}

const unsafeStorageNamespacePermissions = (): never => {
  throw new Error('Unsafe local storage root namespace permissions')
}

const isMissingPathError = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * Resolves the configured root and contained object path.
 *
 * @param bucket - Storage bucket name.
 * @param objectKey - Object key within the bucket.
 * @returns Resolved storage paths.
 */
const resolveLocalStoragePaths = (bucket: string, objectKey: string): LocalStoragePaths => {
  const storageRoot = resolveLocalFileStorageRoot()
  const bucketRoot = resolveContainedStoragePath(storageRoot, bucket, 'bucket')
  return {
    storageRoot,
    targetPath: resolveContainedStoragePath(bucketRoot, objectKey, 'object key')
  }
}

/**
 * Enforces the local provider's trust boundary.
 *
 * The storage tree is owned by the service account and must not be accessible
 * by other accounts. Mutations by the same service account are trusted.
 *
 * @param directoryPath - Storage directory to validate.
 */
const assertPrivateStorageDirectory = async (directoryPath: string): Promise<void> => {
  const directoryStats = await lstat(directoryPath)
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    invalidStorageObjectPath()
  }

  if (process.getuid === undefined) {
    return
  }
  if (
    directoryStats.uid !== process.getuid()
    || (directoryStats.mode & GROUP_OR_OTHER_ACCESS_MASK) !== 0
  ) {
    unsafeStoragePermissions()
  }
}

/**
 * Ensures an untrusted POSIX identity cannot replace the configured root entry.
 *
 * Writable sticky ancestors are safe only when the ancestor is controlled by
 * root or the service and the next path entry is owned by the service.
 *
 * @param initialAncestorPath - First ancestor to validate.
 * @param initialChildUid - Owner of the child entry beneath that ancestor.
 */
const assertStableNamespaceAncestors = async (
  initialAncestorPath: string,
  initialChildUid: number
): Promise<void> => {
  if (process.getuid === undefined) {
    return
  }

  const serviceUid = process.getuid()
  let childUid = initialChildUid
  let ancestorPath = initialAncestorPath

  while (true) {
    const ancestorStats = await lstat(ancestorPath)
    if (ancestorStats.isSymbolicLink() || !ancestorStats.isDirectory()) {
      invalidStorageObjectPath()
    }

    const trustedOwner = ancestorStats.uid === 0 || ancestorStats.uid === serviceUid
    if (!trustedOwner) {
      unsafeStorageNamespacePermissions()
    }

    if ((ancestorStats.mode & GROUP_OR_OTHER_WRITE_MASK) !== 0) {
      const sticky = (ancestorStats.mode & STICKY_BIT_MASK) !== 0
      if (!sticky || childUid !== serviceUid) {
        unsafeStorageNamespacePermissions()
      }
    }

    const nextAncestorPath = dirname(ancestorPath)
    if (nextAncestorPath === ancestorPath) {
      return
    }
    childUid = ancestorStats.uid
    ancestorPath = nextAncestorPath
  }
}

/**
 * Validates that the configured root cannot be replaced by an untrusted identity.
 *
 * @param storageRoot - Configured storage root.
 */
const assertStableStorageRootNamespace = async (storageRoot: string): Promise<void> => {
  if (process.getuid === undefined) {
    return
  }

  const storageRootStats = await lstat(storageRoot)
  await assertStableNamespaceAncestors(dirname(storageRoot), storageRootStats.uid)
}

/**
 * Validates a parent namespace before creating a service-owned child.
 *
 * @param parentPath - Parent directory to validate.
 */
const assertStableOwnedChildNamespace = async (parentPath: string): Promise<void> => {
  if (process.getuid === undefined) {
    return
  }

  await assertStableNamespaceAncestors(parentPath, process.getuid())
}

/**
 * Creates or validates one private storage directory.
 *
 * @param directoryPath - Directory to create or validate.
 */
const createPrivateStorageDirectory = async (directoryPath: string): Promise<void> => {
  let created = false
  try {
    await mkdir(directoryPath, { mode: PRIVATE_DIRECTORY_MODE })
    created = true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }

  if (created) {
    await chmod(directoryPath, PRIVATE_DIRECTORY_MODE)
  }
  await assertPrivateStorageDirectory(directoryPath)
}

/**
 * Creates a missing storage root one component at a time.
 *
 * The existing ancestor namespace is validated before creation, so a newly
 * created entry cannot be replaced by an untrusted identity before chmod.
 *
 * @param storageRoot - Storage root to create or validate.
 */
const ensurePrivateStorageRoot = async (storageRoot: string): Promise<void> => {
  const missingSegments: string[] = []
  let existingPath = storageRoot

  while (true) {
    const existingStats = await lstat(existingPath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null
      }
      throw error
    })
    if (existingStats !== null) {
      if (existingStats.isSymbolicLink() || !existingStats.isDirectory()) {
        invalidStorageObjectPath()
      }
      break
    }

    const parentPath = dirname(existingPath)
    if (parentPath === existingPath) {
      invalidStorageObjectPath()
    }
    missingSegments.unshift(basename(existingPath))
    existingPath = parentPath
  }

  for (const segment of missingSegments) {
    await assertStableOwnedChildNamespace(existingPath)
    existingPath = join(existingPath, segment)
    await createPrivateStorageDirectory(existingPath)
  }
}

/**
 * Creates or validates the service-private directory tree containing an object.
 *
 * @param paths - Resolved root and target paths.
 * @param createDirectories - Whether missing directories may be created.
 * @returns Validated target object path.
 */
const ensurePrivateStorageParent = async (
  paths: LocalStoragePaths,
  createDirectories: boolean
): Promise<string> => {
  if (createDirectories) {
    await ensurePrivateStorageRoot(paths.storageRoot)
  }
  await assertPrivateStorageDirectory(paths.storageRoot)
  await assertStableStorageRootNamespace(paths.storageRoot)

  const parentPath = dirname(paths.targetPath)
  if (isOutsideRoot(paths.storageRoot, parentPath)) {
    invalidStorageObjectPath()
  }

  const relativeParent = relative(paths.storageRoot, parentPath)
  let currentPath = paths.storageRoot
  for (const segment of relativeParent.split(sep).filter(value => value.length > 0)) {
    currentPath = join(currentPath, segment)
    if (createDirectories) {
      await createPrivateStorageDirectory(currentPath)
    } else {
      await assertPrivateStorageDirectory(currentPath)
    }
  }

  return paths.targetPath
}

/**
 * Validates a storage object as a private service-owned regular file.
 *
 * @param fileStats - File metadata to validate.
 */
const assertPrivateStorageFileStats = (
  fileStats: LocalStorageFileStats
): void => {
  if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
    invalidStorageObjectPath()
  }

  if (process.getuid === undefined) {
    return
  }
  if (
    fileStats.uid !== process.getuid()
    || (fileStats.mode & GROUP_OR_OTHER_ACCESS_MASK) !== 0
  ) {
    unsafeStorageFilePermissions()
  }
}

const assertPrivateStorageFile = async (targetPath: string): Promise<void> => {
  assertPrivateStorageFileStats(await lstat(targetPath))
}

/**
 * Writes a new private temporary object without following symbolic links.
 *
 * @param temporaryPath - Exclusive temporary file path.
 * @param bytes - Object bytes to write.
 */
const writeTemporaryObject = async (temporaryPath: string, bytes: Uint8Array): Promise<void> => {
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE
  )
  try {
    await handle.chmod(PRIVATE_FILE_MODE)
    const temporaryStats = await handle.stat()
    assertPrivateStorageFileStats(temporaryStats)
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
}

/**
 * Resolves an object beneath the configured local attachment root.
 *
 * @param bucket - Storage bucket name.
 * @param objectKey - Object key within the bucket.
 * @returns Absolute object path.
 */
export const resolveLocalStorageObjectPath = (bucket: string, objectKey: string): string => {
  return resolveLocalStoragePaths(bucket, objectKey).targetPath
}

/**
 * Reads an object from the service-private local storage tree.
 *
 * @param bucket - Storage bucket name.
 * @param objectKey - Object key within the bucket.
 * @returns Stored object bytes.
 */
export const readLocalStorageObject = async (bucket: string, objectKey: string): Promise<Buffer> => {
  const paths = resolveLocalStoragePaths(bucket, objectKey)
  const targetPath = await ensurePrivateStorageParent(paths, false)
  await assertPrivateStorageFile(targetPath)
  const handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    assertPrivateStorageFileStats(await handle.stat())
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/**
 * Atomically writes an object within the service-private local storage tree.
 *
 * @param bucket - Storage bucket name.
 * @param objectKey - Object key within the bucket.
 * @param bytes - Object bytes.
 */
export const writeLocalStorageObject = async (
  bucket: string,
  objectKey: string,
  bytes: Uint8Array
): Promise<void> => {
  const paths = resolveLocalStoragePaths(bucket, objectKey)
  const targetPath = await ensurePrivateStorageParent(paths, true)
  const existingTarget = await lstat(targetPath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return null
    }
    throw error
  })
  if (existingTarget !== null) {
    assertPrivateStorageFileStats(existingTarget)
  }

  const temporaryPath = join(dirname(targetPath), `.gcs-tmp-${nanoid(12)}`)
  try {
    await writeTemporaryObject(temporaryPath, bytes)
    await rename(temporaryPath, targetPath)
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

/**
 * Deletes an object from the service-private local storage tree.
 *
 * @param bucket - Storage bucket name.
 * @param objectKey - Object key within the bucket.
 */
export const deleteLocalStorageObject = async (bucket: string, objectKey: string): Promise<void> => {
  const paths = resolveLocalStoragePaths(bucket, objectKey)
  const targetPath = await ensurePrivateStorageParent(paths, false)
  await assertPrivateStorageFile(targetPath)
  await unlink(targetPath)
}

