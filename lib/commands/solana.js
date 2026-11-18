import fs from 'node:fs/promises';
import { getCompiledTransactionMessageCodec } from '@solana/transaction-messages';
import { getTransactionCodec } from '@solana/transactions';
import { Command } from 'commander';
import { reviewTransaction } from '../lib/terminal-ui.js';
import { openSolanaSigner } from '../lib/wallet.js';
const systemProgram = '11111111111111111111111111111111';
const tokenPrograms = new Set([
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
function decodeTransaction(bytes) {
    try {
        const codec = getTransactionCodec();
        const transaction = codec.decode(bytes);
        if (!Buffer.from(codec.encode(transaction)).equals(bytes))
            throw new Error();
        const messageCodec = getCompiledTransactionMessageCodec();
        const message = messageCodec.decode(transaction.messageBytes);
        if (!Buffer.from(messageCodec.encode(message)).equals(Buffer.from(transaction.messageBytes)))
            throw new Error();
        return { transaction, message };
    }
    catch {
        throw new Error('invalid serialized Solana transaction');
    }
}
function describeInstruction(program, data) {
    if (program === systemProgram && data.length === 12 && data.readUInt32LE(0) === 2) {
        return `SOL transfer of ${data.readBigUInt64LE(4)} lamports`;
    }
    if (tokenPrograms.has(program)) {
        if (data.length === 9 && data[0] === 3)
            return `SPL token transfer of ${data.readBigUInt64LE(1)} base units`;
        if (data.length === 10 && data[0] === 12) {
            return `SPL checked token transfer of ${data.readBigUInt64LE(1)} base units (${data[9]} decimals)`;
        }
    }
    if (program === systemProgram && data.equals(Buffer.of(4, 0, 0, 0)))
        return 'Advance durable nonce';
    return `Program instruction (amount and effects undecoded, data: ${data.length ? data.toString('hex') : 'empty'})`;
}
function summarizeSolanaTransaction(message) {
    const lookups = message.version === 0 ? message.addressTableLookups ?? [] : [];
    const accounts = [...message.staticAccounts];
    for (const role of ['writableIndexes', 'readonlyIndexes']) {
        for (const lookup of lookups) {
            for (const index of lookup[role])
                accounts.push(`unresolved lookup ${lookup.lookupTableAddress}[${index}]`);
        }
    }
    const accountAt = (index) => {
        const account = accounts[index];
        if (!account)
            throw new Error('invalid Solana transaction account index');
        return account;
    };
    const instructions = message.version === 1
        ? message.instructionHeaders.map(({ programAccountIndex }, index) => ({
            programAddressIndex: programAccountIndex,
            accountIndices: message.instructionPayloads[index].instructionAccountIndices,
            data: message.instructionPayloads[index].instructionData,
        }))
        : message.instructions;
    const first = instructions[0];
    const durableNonce = first && accountAt(first.programAddressIndex) === systemProgram &&
        Buffer.from(first.data ?? []).equals(Buffer.of(4, 0, 0, 0));
    const lifetime = message.lifetimeToken;
    const expiry = durableNonce
        ? `Expiry depends on the durable nonce (${lifetime}).`
        : `Expiry depends on the recent blockhash (${lifetime}). The exact expiry cannot be determined offline.`;
    return [
        `Solana ${message.version === 'legacy' ? 'legacy' : `v${message.version}`} transaction`,
        `Fee payer: ${accountAt(0)}`,
        `Required signers: ${message.staticAccounts.slice(0, message.header.numSignerAccounts).join(', ')}`,
        expiry,
        ...instructions.map((instruction, index) => {
            const program = accountAt(instruction.programAddressIndex);
            const instructionAccounts = instruction.accountIndices?.map(accountAt) ?? [];
            return `${index + 1}. ${describeInstruction(program, Buffer.from(instruction.data ?? []))}\n` +
                `   Program: ${program}\n   Accounts: ${instructionAccounts.join(', ') || 'none'}`;
        }),
    ].join('\n');
}
async function signDecodedTransaction(transaction, signer) {
    const transactionCodec = getTransactionCodec();
    const address = Object.keys(transaction.signatures).find((address) => address === signer.publicKey);
    if (!address)
        throw new Error('the selected key is not a required signer for this Solana transaction');
    const signature = await signer.sign(Buffer.from(transaction.messageBytes));
    return Buffer.from(transactionCodec.encode({
        ...transaction,
        signatures: { ...transaction.signatures, [address]: signature },
    }));
}
export async function signSolanaTransaction(bytes, signer) {
    return signDecodedTransaction(decodeTransaction(bytes).transaction, signer);
}
async function readTransaction(file) {
    const encoded = (await fs.readFile(file, 'utf8')).trim();
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.toString('base64') !== encoded || bytes.length > 4096) {
        throw new Error('expected a file containing one base64-encoded Solana transaction');
    }
    return bytes;
}
export function createSolanaCommand() {
    const solana = new Command('solana').description('Sign Solana transactions locally');
    solana
        .command('sign-transaction <file>')
        .description('Add a signature to a base64 wire transaction without broadcasting')
        .requiredOption('-k, --key <name>', 'encrypted ed25519 key name')
        .option('-o, --output <file>', 'write signed base64 transaction to a new file')
        .option('--yes', 'sign without an interactive confirmation')
        .action(async (file, options) => {
        const { transaction, message } = decodeTransaction(await readTransaction(file));
        await reviewTransaction(summarizeSolanaTransaction(message), options.yes);
        const signed = await signDecodedTransaction(transaction, await openSolanaSigner(options.key));
        const output = signed.toString('base64') + '\n';
        if (options.output)
            await fs.writeFile(options.output, output, { flag: 'wx', mode: 0o600 });
        else
            process.stdout.write(output);
    });
    return solana;
}
