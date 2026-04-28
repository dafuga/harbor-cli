import {Command} from 'commander'
import {getTableRows} from '../lib/tx.js'

export function createTableCommand(): Command {
  const table = new Command('table')
  table
    .description('Read chain table rows')
    .argument('<contract>')
    .argument('<table>')
    .option('-u, --url <url>', 'Harbor chain API URL', process.env.HARBOR_API_URL ?? 'http://127.0.0.1:8888')
    .option('-s, --scope <scope>', 'table scope')
    .option('-l, --limit <limit>', 'row limit', '100')
    .option('--lower-bound <value>', 'lower bound')
    .option('--upper-bound <value>', 'upper bound')
    .option('--json', 'print JSON')
    .action(async (contract: string, tableName: string, options) => {
      const rows = await getTableRows(contract, tableName, {
        url: options.url,
        scope: options.scope,
        limit: Number(options.limit),
        lowerBound: options.lowerBound,
        upperBound: options.upperBound,
      })
      if (options.json) {
        console.log(JSON.stringify(rows.rows, null, 2))
      } else {
        console.table(rows.rows)
      }
    })

  return table
}
