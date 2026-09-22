#!/usr/bin/env node
/**
 * A TLS server that answers every request with what it saw: the SNI server name of the connection
 * and the `Host` header. Always run under Node, in its own process, because the question it answers
 * is what the *client* runtime put on the wire — and Bun's own TLS server does not expose the server
 * name it was offered.
 *
 * argv: <key.pem> <cert.pem>. Prints `{"port":N}` on stdout once listening.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'

const [keyPath, certPath] = process.argv.slice(2)
const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
  const body = JSON.stringify({ servername: req.socket.servername ?? null, host: req.headers.host ?? null })
  res
    .writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    .end(body)
})
server.listen(0, '127.0.0.1', () =>
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`)
)
process.on('SIGTERM', () => process.exit(0))
