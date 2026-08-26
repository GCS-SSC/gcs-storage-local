import {
  defineGcsFileStorageProviderAdapter,
  type GcsFileStorageOperationContext,
  type GcsFileStorageProviderAdapterBase
} from '@gcs-ssc/extensions/server'
import {
  deleteLocalStorageObject,
  readLocalStorageObject,
  writeLocalStorageObject
} from './local-file-storage.ts'

const LOCAL_OBJECT_BUCKET = 'gcs-storage-local'

const requireObjectKey = (context: GcsFileStorageOperationContext): string => {
  const objectKey = context.locator.objectKey
  if (typeof objectKey !== 'string' || objectKey.length === 0 || objectKey !== context.objectId) {
    throw new Error('Invalid local storage object locator')
  }
  return objectKey
}

const adapter = {
  writeObject: async (input) => {
    await writeLocalStorageObject(LOCAL_OBJECT_BUCKET, input.objectName, input.bytes)
    return {
      objectId: input.objectName,
      locator: { objectKey: input.objectName }
    }
  },
  readObject: async (context) => ({
    bytes: await readLocalStorageObject(LOCAL_OBJECT_BUCKET, requireObjectKey(context))
  }),
  deleteObject: async (context) => {
    const objectKey = requireObjectKey(context)
    await deleteLocalStorageObject(LOCAL_OBJECT_BUCKET, objectKey).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
} satisfies GcsFileStorageProviderAdapterBase

export default defineGcsFileStorageProviderAdapter(adapter)
