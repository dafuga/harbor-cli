import fs from 'node:fs/promises'

const [q4Endpoint, q4Model, bf16Endpoint, bf16Model, report] = process.argv.slice(2)
if (!q4Endpoint || !q4Model || !bf16Endpoint || !bf16Model || !report) {
  throw new Error('usage: node scripts/qwen-harbor-eval.mjs <q4-url> <q4-model> <bf16-url> <bf16-model> <report.json>')
}

function loopback(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('evaluation servers must be isolated HTTP loopback endpoints')
  }
  return url
}

const tools = [
  {name: 'get_account', fields: {account: {type: 'string'}}, description: 'Read a Harbor account and its on-chain balance.'},
  {name: 'quote_inference', fields: {model_id: {type: 'string'}, max_tokens: {type: 'integer'}}, description: 'Quote a request in Harbor tokens without submitting it.'},
  {name: 'service_status', fields: {service: {type: 'string'}}, description: 'Read the status of a local Harbor service.'},
].map(({name, fields, description}) => ({
  type: 'function',
  function: {name, description, parameters: {type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false}},
}))

const cases = [
  {id: 'account', input: 'Look up the balance for harboralice.', tool: 'get_account', args: {account: 'harboralice'}},
  {id: 'precision', input: 'Quote model ID 9007199254740993 with a maximum of 64 tokens.', tool: 'quote_inference', args: {model_id: '9007199254740993', max_tokens: 64}},
  {id: 'service', input: 'Check whether the verifier service is running.', tool: 'service_status', args: {service: 'verifier'}},
  {id: 'missing-account', input: 'Please look up my balance. I did not provide a Harbor account.', tool: null},
  {id: 'unsupported-action', input: 'Transfer 20 HRBR to harboralice immediately. Do not request a quote.', tool: null},
]

function sameArgs(actual, expected) {
  return Boolean(actual && Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value))
}

const results = []
for (const [precision, url, model] of [['q4', loopback(q4Endpoint), q4Model], ['bf16', loopback(bf16Endpoint), bf16Model]]) {
  for (const item of cases) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 192,
        messages: [
          {role: 'system', content: 'You are a Harbor assistant. Use exactly one offered tool when all required arguments are supplied. Preserve identifiers as strings. Never invent arguments. Decline unavailable actions.'},
          {role: 'user', content: item.input},
        ],
        tools,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) throw new Error(`${precision} evaluation returned HTTP ${response.status}`)
    const body = await response.json()
    const calls = body.choices?.[0]?.message?.tool_calls ?? []
    let args
    try { args = JSON.parse(calls[0]?.function?.arguments) } catch { /* Missing or malformed arguments fail the case. */ }
    const pass = item.tool === null ? calls.length === 0 : (
      calls.length === 1 && calls[0].function?.name === item.tool && sameArgs(args, item.args)
    )
    results.push({precision, model, case: item.id, pass, tool_calls: calls.length})
  }
}
await fs.writeFile(report, `${JSON.stringify(results, null, 2)}\n`, {flag: 'wx', mode: 0o600})
for (const precision of ['q4', 'bf16']) {
  const rows = results.filter((row) => row.precision === precision)
  console.log(`${precision}: ${rows.filter(({pass}) => pass).length}/${rows.length} tool-call cases`)
}
