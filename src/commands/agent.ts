import {Command} from 'commander'
import net from 'node:net'

interface AgentStatusOptions {
  apiPort: string
  roboPort: string
  storagePort: string
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({host: '127.0.0.1', port})
    socket.setTimeout(1000)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

export function createAgentCommand(): Command {
  const agent = new Command('agent')
  agent.description('Inspect and run Harbor service agents')

  agent
    .command('status')
    .description('Check local Harbor service ports')
    .option('--api-port <port>', 'Spring chain API port', '8888')
    .option('--robo-port <port>', 'Roborovski API port', '8080')
    .option('--storage-port <port>', 'Harbor storage manifest port', '9090')
    .action(async (options: AgentStatusOptions) => {
      const checks = [
        {service: 'chain-api', port: Number(options.apiPort)},
        {service: 'robo-history', port: Number(options.roboPort)},
        {service: 'storage-manifest', port: Number(options.storagePort)},
      ]

      const results = await Promise.all(
        checks.map(async (check) => ({
          ...check,
          reachable: await canConnect(check.port),
        }))
      )

      console.table(results)
    })

  return agent
}
