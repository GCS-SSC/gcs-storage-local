import { defineGcsExtension } from '@gcs-ssc/extensions'

export default defineGcsExtension({
  key: 'gcs-storage-local',
  sdkVersion: '^0.2.1',
  requiredHostCapabilities: ['file-storage-provider'],
  name: {
    en: 'Local file storage',
    fr: 'Stockage local de fichiers'
  },
  description: {
    en: 'Stores private attachment objects on the host filesystem.',
    fr: 'Stocke les objets de pièces jointes privées dans le système de fichiers de l’hôte.'
  },
  fileStorageProvider: {
    adapter: { path: './server/storage-adapter.ts' }
  }
})
