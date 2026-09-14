/**
 * A minimal S3-compatible server: enough for the plugin's two object reads
 * and its conditional writes, with none of the signing. It exists so the
 * conflict path can be exercised without a bucket, a credential, or a network
 * round trip to a real service.
 *
 * Supported: `GET /{bucket}/{key}` and `PUT /{bucket}/{key}` with `If-Match`
 * and `If-None-Match: *`. Every other request answers 400 so a change in the
 * plugin's SDK usage fails loudly here instead of passing silently.
 */

import { createServer } from 'node:http'

/** XML error body in the shape the SDK recognizes. */
function errorBody(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`
}

/**
 * Decode an `aws-chunked` body into its payload. The SDK streams signed
 * chunks; the fake service only needs the bytes.
 */
function decodeBody(buffer, headers) {
  const encoded = `${headers['content-encoding'] ?? ''}`.includes('aws-chunked')
    || `${headers['x-amz-content-sha256'] ?? ''}`.startsWith('STREAMING-')
  if (!encoded) return buffer.toString('utf8')
  let rest = buffer
  const parts = []
  for (;;) {
    const end = rest.indexOf('\r\n')
    if (end === -1) break
    const size = Number.parseInt(rest.subarray(0, end).toString('utf8').split(';')[0], 16)
    if (!Number.isFinite(size) || size === 0) break
    parts.push(rest.subarray(end + 2, end + 2 + size).toString('utf8'))
    rest = rest.subarray(end + 2 + size + 2)
  }
  return parts.join('')
}

/**
 * Start the fake service.
 * @param {number} port - port to listen on; 0 picks a free one.
 * @returns {Promise<{ url: string, objects: Map<string, string>, stop: () => Promise<void> }>}
 */
export async function startFakeS3(port = 0) {
  /** key → text; the ETag is the number of writes that produced it. */
  const objects = new Map()
  const versions = new Map()
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const path = decodeURIComponent(new URL(request.url, 'http://fake').pathname).replace(/^\/+/u, '')
      const slash = path.indexOf('/')
      const key = slash === -1 ? '' : path.slice(slash + 1)
      const body = decodeBody(Buffer.concat(chunks), request.headers)
      const send = (status, payload, headers = {}) => {
        response.writeHead(status, { 'content-type': 'application/xml', ...headers })
        response.end(payload)
      }
      if (request.method === 'GET') {
        if (!objects.has(key)) return send(404, errorBody('NoSuchKey', 'The specified key does not exist.'))
        return send(200, objects.get(key), { etag: versions.get(key), 'content-type': 'application/octet-stream' })
      }
      if (request.method === 'PUT') {
        const ifMatch = request.headers['if-match']
        const ifNoneMatch = request.headers['if-none-match']
        if (ifNoneMatch === '*' && objects.has(key)) {
          return send(412, errorBody('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold'))
        }
        if (ifMatch !== undefined && ifMatch !== versions.get(key)) {
          return send(412, errorBody('PreconditionFailed', 'At least one of the pre-conditions you specified did not hold'))
        }
        const next = (Number.parseInt((versions.get(key) ?? '"0"').replaceAll('"', ''), 10) || 0) + 1
        objects.set(key, body)
        versions.set(key, `"${next}"`)
        return send(200, '', { etag: versions.get(key) })
      }
      return send(400, errorBody('InvalidRequest', `${request.method} is not implemented by the fake service`))
    })
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    objects,
    stop: () => new Promise((resolve) => { server.close(() => resolve()) }),
  }
}
