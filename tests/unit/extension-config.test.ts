import { describe, expect, it } from 'vitest'
import extension from '../../extension.config'

describe('local storage extension manifest', () => {
  it('declares only the host storage-provider capability', () => {
    expect(extension.key).toBe('gcs-storage-local')
    expect(extension.sdkVersion).toBe('^0.2.1')
    expect(extension.requiredHostCapabilities).toEqual(['file-storage-provider'])
  })

  it('contributes one adapter without configuration UI or custom metadata', () => {
    expect(extension.fileStorageProvider).toEqual({
      adapter: { path: './server/storage-adapter.ts' }
    })
    expect(extension.admin).toBeUndefined()
    expect(extension.serverHandlers).toBeUndefined()
  })
})
