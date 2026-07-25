import assert from 'node:assert/strict'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import test from 'node:test'
import {readContractNextId} from './tx.js'

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

test('readContractNextId reads singleton params without assuming payload id is the physical key', async () => {
  const nextObjectId = '9007199254740993'
  let requestUrl: string | undefined
  let requestBody: Record<string, unknown> | undefined
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      requestUrl = request.url
      requestBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      response.writeHead(200, {'content-type': 'application/json'})
      response.end(JSON.stringify({
        rows: [{id: 0, required_replicas: 2, next_object_id: nextObjectId}],
        more: false,
      }))
    })
  })

  try {
    const url = await listen(server)
    assert.equal(
      await readContractNextId('harborstore', 'next_object_id', {url}),
      nextObjectId,
    )
    assert.equal(requestUrl, '/v1/chain/get_table_rows')
    assert.equal(requestBody?.code, 'harborstore')
    assert.equal(requestBody?.scope, 'harborstore')
    assert.equal(requestBody?.table, 'params')
    assert.equal(requestBody?.limit, 2)
    assert.equal('lower_bound' in (requestBody ?? {}), false)
    assert.equal('upper_bound' in (requestBody ?? {}), false)
    assert.equal('index_position' in (requestBody ?? {}), false)
  } finally {
    await close(server)
  }
})

test('readContractNextId accepts a singleton payload without an id member', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'application/json'})
    response.end(JSON.stringify({
      rows: [{next_artifact_id: '18446744073709551614'}],
      more: false,
    }))
  })

  try {
    const url = await listen(server)
    assert.equal(
      await readContractNextId('harborai', 'next_artifact_id', {url}),
      '18446744073709551614',
    )
  } finally {
    await close(server)
  }
})

test('readContractNextId rejects absent, ambiguous, and unsafe numeric allocators', async (t) => {
  const cases: Array<{
    name: string
    rows: Array<Record<string, unknown>>
    error: RegExp
  }> = [
    {
      name: 'missing allocator field',
      rows: [{id: 0, next_model_id: '7'}],
      error: /harborstore params do not expose next_object_id/,
    },
    {
      name: 'ambiguous allocator rows',
      rows: [
        {id: 0, next_object_id: '7'},
        {id: 1, next_object_id: '8'},
      ],
      error: /harborstore params do not expose next_object_id/,
    },
    {
      name: 'unsafe JSON number',
      rows: [{id: 0, next_object_id: 9_007_199_254_740_992}],
      error: /harborstore next_object_id must be an unsigned 64-bit integer/,
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const server = http.createServer((_request, response) => {
        response.writeHead(200, {'content-type': 'application/json'})
        response.end(JSON.stringify({rows: fixture.rows, more: false}))
      })
      try {
        const url = await listen(server)
        await assert.rejects(
          () => readContractNextId('harborstore', 'next_object_id', {url}),
          fixture.error,
        )
      } finally {
        await close(server)
      }
    })
  }
})
