/**
 * Run the fake S3 service standalone so a real `dsh` boot can point at it.
 * Logs every request, which is how a boot check proves the providers actually
 * reached storage.
 */

import { startFakeS3 } from './fake-s3.mjs'

const port = Number(process.argv[2] ?? 9711)
const service = await startFakeS3(port)
console.log(`fake-s3 listening on ${service.url}`)
setInterval(() => {
  for (const [key, text] of service.objects) console.log(`object ${key} (${text.length} bytes)`)
}, 5000).unref()
