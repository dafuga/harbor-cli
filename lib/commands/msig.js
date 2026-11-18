import { Checksum256, Name, PermissionLevel, Serializer, Transaction } from '@wharfkit/antelope';
import { Command } from 'commander';
import { clientFor, getAbi, getTableRows, parseJson, permissionLevel, printResult, serializeAction } from '../lib/tx.js';
import { addTxOptions, pushJsonAction } from './action.js';
function msigContract(command) {
    return command.option('--msig-contract <account>', 'multisig contract account', process.env.HARBOR_MSIG_CONTRACT ?? 'eosio.msig');
}
function permissionList(value) {
    const permissions = value.split(',').map(permission);
    if (new Set(permissions.map(String)).size !== permissions.length)
        throw new Error('duplicate permission in list');
    return permissions;
}
function permission(value) {
    if (!/^[.1-5a-z]{1,13}@[.1-5a-z]{1,13}$/.test(value))
        throw new Error('expected an account@permission level');
    return PermissionLevel.from(value);
}
export function createMsigCommand() {
    const msig = new Command('msig').description('Propose, review, approve and execute Antelope multisig transactions');
    msigContract(addTxOptions(msig.command('propose <proposal> <contract> <action> <data-json>')))
        .description('Propose a transaction for the requested account permissions')
        .requiredOption('--requested <levels>', 'comma-separated account@permission approvers')
        .requiredOption('--action-auth <levels>', 'comma-separated account@permission levels on the proposed action')
        .option('--proposal-expiration <seconds>', 'how long the proposal remains executable', '86400')
        .action(async (proposal, contract, action, data, options) => {
        const signer = permissionLevel(options);
        const seconds = Number(options.proposalExpiration);
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 0xffffffff) {
            throw new Error('proposal expiration must be a positive number of seconds');
        }
        const requested = permissionList(options.requested);
        const actionAuth = permissionList(options.actionAuth);
        const proposedAction = await serializeAction({
            contract, action, data: parseJson(data), url: options.url, authorization: actionAuth.join(','),
        });
        const info = await clientFor(options.url).v1.chain.get_info();
        const trx = Transaction.from({ ...info.getTransactionHeader(seconds), actions: [proposedAction] });
        await pushJsonAction(options.msigContract, 'propose', {
            proposer: signer.actor, proposal_name: proposal, requested, trx,
        }, { ...options, ...signer });
    });
    msigContract(msig.command('show <proposer> <proposal>').option('-u, --url <url>', 'Harbor chain API URL'))
        .description('Decode proposed actions and show the hash required for approval')
        .action(async (proposer, proposal, options) => {
        const proposalName = Name.from(proposal).toString();
        const result = await getTableRows(options.msigContract, 'proposal', { scope: proposer, lowerBound: proposalName, limit: 1, url: options.url });
        const row = result.rows.find((item) => item.proposal_name === proposalName);
        if (!row)
            throw new Error('multisig proposal not found');
        const trx = Serializer.decode({ data: row.packed_transaction, type: Transaction });
        const actions = await Promise.all(trx.actions.map(async (action) => ({
            ...action,
            data: action.decodeData(await getAbi(action.account.toString(), options.url)),
        })));
        printResult({
            proposer, proposal_name: proposalName, proposal_hash: Checksum256.hash(row.packed_transaction),
            transaction: { ...trx, actions },
        }, true);
    });
    msigContract(addTxOptions(msig.command('approve <proposer> <proposal> <level>')))
        .description('Approve the reviewed proposal as one requested permission')
        .requiredOption('--proposal-hash <checksum>', 'checksum printed by msig show')
        .action(async (proposer, proposal, level, options) => {
        const approver = permission(level);
        await pushJsonAction(options.msigContract, 'approve', {
            proposer, proposal_name: proposal, level: approver,
            proposal_hash: Checksum256.from(options.proposalHash),
        }, { ...options, actor: approver.actor.toString(), permission: approver.permission.toString(), auth: approver.toString() });
    });
    msigContract(addTxOptions(msig.command('exec <proposer> <proposal>')))
        .description('Execute a proposal after its requested approvals satisfy the authority')
        .action(async (proposer, proposal, options) => {
        const signer = permissionLevel(options);
        await pushJsonAction(options.msigContract, 'exec', {
            proposer, proposal_name: proposal, executer: signer.actor,
        }, { ...options, ...signer });
    });
    return msig;
}
