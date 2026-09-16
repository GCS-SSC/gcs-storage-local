import { describe, expect, it } from 'vitest'
import extension from '../../extension.config'

describe('local storage extension manifest', () => {
  it('declares storage and explicit audit ownership capabilities', () => {
    expect(extension.key).toBe('gcs-storage-local')
    expect(extension.sdkVersion).toBe('^0.3.2')
    expect(extension.requiredHostCapabilities).toEqual(['audit-ownership', 'file-storage-provider'])
  })

  it('contributes one adapter without configuration UI or custom metadata', () => {
    expect(extension.fileStorageProvider).toEqual({
      adapter: { path: './server/storage-adapter.ts' }
    })
    expect(extension.admin).toBeUndefined()
    expect(extension.serverHandlers).toBeUndefined()
  })
})
