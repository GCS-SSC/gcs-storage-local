import extension from '../../extension.config'
// Integration adapter from the host tooling checkout; production code uses only the SDK.
const { verifyExtensionAuditContract } = await import(new URL(
  '../../../../tooling/gcs-ssc/tests/fixtures/extension-audit-contract.ts', import.meta.url
).href)

verifyExtensionAuditContract(extension, [
  {
    'table': 'extensions.agency_enablement',
    'row': {
      'id': '90',
      'agency_id': '11',
      'extension_key': 'gcs-storage-local'
    },
    'agencies': [
      '11'
    ]
  },
  {
    'table': 'extensions.stream_configuration',
    'row': {
      'id': '91',
      'stream_id': '201',
      'extension_key': 'gcs-storage-local'
    },
    'agencies': [
      '11'
    ]
  }
])
