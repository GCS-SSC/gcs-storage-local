import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import adapter from '../../server/storage-adapter'
import { LOCAL_FILE_STORAGE_DIR_ENV } from '../../server/local-file-storage'
import type { GcsFileStorageOperationContext, GcsFileStorageWriteObjectInput } from '@gcs-ssc/extensions/server'

const originalRoot = process.env[LOCAL_FILE_STORAGE_DIR_ENV]
const roots: string[] = []
const secrets = { get: async () => null }

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'gcs-storage-local-adapter-'))
  roots.push(root)
  process.env[LOCAL_FILE_STORAGE_DIR_ENV] = root
  await chmod(root, 0o700)
  return root
}

const writeInput = (objectName = '01JLOCALOBJECT'): GcsFileStorageWriteObjectInput => ({
  objectName,
  bytes: Buffer.from('private object'),
  contentType: 'application/octet-stream',
  agencyId: '17',
  purpose: 'attachment',
  target: { entityType: 'fundingcaseagreement', entityId: '42' },
  agencyConfig: {},
  secrets
})

const operationContext = (objectId = '01JLOCALOBJECT'): GcsFileStorageOperationContext => ({
  objectId,
  locator: { objectKey: objectId },
  agencyId: '17',
  purpose: 'attachment',
  target: { entityType: 'fundingcaseagreement', entityId: '42' },
  agencyConfig: {},
  secrets
})

afterEach(async () => {
  if (originalRoot === undefined) delete process.env[LOCAL_FILE_STORAGE_DIR_ENV]
  else process.env[LOCAL_FILE_STORAGE_DIR_ENV] = originalRoot
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('local file storage provider adapter', () => {
  it('writes with the host identity and returns a JSON-only stable locator', async () => {
    const root = await createRoot()
    const reference = await adapter.writeObject(writeInput())

    expect(reference).toEqual({
      objectId: '01JLOCALOBJECT',
      locator: { objectKey: '01JLOCALOBJECT' }
    })
    await expect(readFile(join(root, 'gcs-storage-local', '01JLOCALOBJECT'), 'utf8'))
      .resolves.toBe('private object')
  })

  it('reads bytes without returning provider metadata', async () => {
    await createRoot()
    await adapter.writeObject(writeInput())

    const result = await adapter.readObject(operationContext())
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('private object')
    expect(result).toEqual({ bytes: expect.any(Buffer) })
  })

  it('deletes objects and is idempotent when the object is absent', async () => {
    const root = await createRoot()
    await adapter.writeObject(writeInput())
    await adapter.deleteObject(operationContext())
    await expect(access(join(root, 'gcs-storage-local', '01JLOCALOBJECT'))).rejects.toThrow()
    await expect(adapter.deleteObject(operationContext())).resolves.toBeUndefined()
  })

  it.skipIf(process.getuid === undefined)('retries a failed object and safely replays a partially deleted batch', async () => {
    const root = await createRoot()
    const objectIds = ['01JFIRSTOBJECT', '01JRETRYOBJECT', '01JLASTOBJECT']
    for (const objectId of objectIds) await adapter.writeObject(writeInput(objectId))
    const retryPath = join(root, 'gcs-storage-local', '01JRETRYOBJECT')
    await chmod(retryPath, 0o644)

    await adapter.deleteObject(operationContext('01JFIRSTOBJECT'))
    await expect(adapter.deleteObject(operationContext('01JRETRYOBJECT')))
      .rejects.toThrow('Unsafe local storage file permissions')
    await adapter.deleteObject(operationContext('01JLASTOBJECT'))

    await expect(access(join(root, 'gcs-storage-local', '01JFIRSTOBJECT')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(retryPath, 'utf8')).resolves.toBe('private object')
    await expect(access(join(root, 'gcs-storage-local', '01JLASTOBJECT')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    await chmod(retryPath, 0o600)
    await adapter.deleteObject(operationContext('01JRETRYOBJECT'))
    for (const objectId of objectIds) {
      await expect(adapter.deleteObject(operationContext(objectId))).resolves.toBeUndefined()
      await expect(access(join(root, 'gcs-storage-local', objectId)))
        .rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('rejects malformed or identity-mismatched locators', async () => {
    await createRoot()
    await expect(adapter.readObject({
      ...operationContext(),
      locator: { objectKey: '../escape' }
    })).rejects.toThrow('Invalid local storage object locator')
    await expect(adapter.deleteObject({
      ...operationContext(),
      locator: {}
    })).rejects.toThrow('Invalid local storage object locator')
  })

  it('rejects unsafe host object names through the filesystem boundary', async () => {
    await createRoot()
    await expect(adapter.writeObject(writeInput('../escape'))).rejects.toThrow('Invalid object key')
  })
})
