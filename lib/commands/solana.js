import fs from 'node:fs/promises';
import { getCompiledTransactionMessageCodec } from '@solana/transaction-messages';
import { getTransactionCodec } from '@solana/transactions';
import { Command } from 'commander';
import { openSolanaSigner } from '../lib/wallet.js';
export async function signSolanaTransaction(bytes, signer) {
    const transactionCodec = getTransactionCodec();
    let transaction;
    try {
        transaction = transactionCodec.decode(bytes);
        if (!Buffer.from(transactionCodec.encode(transaction)).equals(bytes))
            throw new Error();
        const messageCodec = getCompiledTransactionMessageCodec();
        const message = messageCodec.decode(transaction.messageBytes);
        if (!Buffer.from(messageCodec.encode(message)).equals(Buffer.from(transaction.messageBytes)))
            throw new Error();
    }
    catch {
        throw new Error('invalid serialized Solana transaction');
    }
    const address = Object.keys(transaction.signatures).find((address) => address === signer.publicKey);
    if (!address)
        throw new Error('the selected key is not a required signer for this Solana transaction');
    const signature = await signer.sign(Buffer.from(transaction.messageBytes));
    return Buffer.from(transactionCodec.encode({
        ...transaction,
        signatures: { ...transaction.signatures, [address]: signature },
    }));
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
        .action(async (file, options) => {
        const bytes = await readTransaction(file);
        const signed = await signSolanaTransaction(bytes, await openSolanaSigner(options.key));
        const output = signed.toString('base64') + '\n';
        if (options.output)
            await fs.writeFile(options.output, output, { flag: 'wx', mode: 0o600 });
        else
            process.stdout.write(output);
    });
    return solana;
}
