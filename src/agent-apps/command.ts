import {randomBytes} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {hostname} from 'node:os'
import {resolve} from 'node:path'
import {Command} from 'commander'
import {openAntelopeWorkerSigner} from '../lib/wallet.js'
import {harborConfig} from './config.js'
import {addImportCommand} from './import-command.js'
import {HarborNetwork} from './network.js'
import {workerServer} from './server.js'
import {AgentWorker} from './worker.js'
import {text} from './validation.js'

export function createAgentAppsCommand() {
  const agents = new Command('agents').description('Host always-on Harbor agent apps and routines')
  agents.command('token').description('Generate a worker authentication token')
    .action(() => console.log(randomBytes(32).toString('base64url')))
  agents.command('serve').description('Serve one Harbor testnet account on an always-on host')
    .requiredOption('--config <file>', 'runner configuration JSON')
    .requiredOption('--db <file>', 'persistent SQLite database on this host')
    .option('--port <number>', 'loopback port for a private HTTPS proxy', '9131')
    .action(async (options: {config: string; db: string; port: string}) => {
      const port = Number(options.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Worker port is invalid.')
      const token = process.env.HARBOR_AGENT_TOKEN ?? ''
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Set a dedicated HARBOR_AGENT_TOKEN using harbor agents token.')
      const raw = JSON.parse(await readFile(resolve(options.config), 'utf8'))
      const config = harborConfig(raw)
      const host = text(raw.host ?? hostname(), 'Always-on host name', 160)
      const signer = await openAntelopeWorkerSigner(config.key)
      try {
        const network = new HarborNetwork(config, signer)
        await network.ready()
        const worker = new AgentWorker(resolve(options.db), host, network)
        const server = workerServer(worker, token)
        try {
          await new Promise<void>((done, reject) => {
            server.once('error', reject)
            server.listen(port, '127.0.0.1', done)
          })
          console.log(`Harbor agents worker for ${config.account} at http://127.0.0.1:${port} (${host})`)
          let active: Promise<void> | undefined
          const timer = setInterval(() => {
            if (active) return
            active = worker.tick().catch(() => { process.stderr.write('Harbor agents worker tick failed.\n') })
              .finally(() => { active = undefined })
          }, 1000)
          try {
            await new Promise<void>(done => {
              process.once('SIGINT', done)
              process.once('SIGTERM', done)
            })
          } finally {
            clearInterval(timer)
            worker.stop()
            await new Promise<void>(done => server.close(() => done()))
            await active
          }
        } finally {
          worker.close()
        }
      } finally {
        signer.close()
      }
    })
  addImportCommand(agents)
  return agents
}
