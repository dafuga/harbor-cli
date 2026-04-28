import { Command } from 'commander';
import qrcode from 'qrcode-terminal';
import { SigningRequest } from '@wharfkit/signing-request';
import zlib from 'pako';
import { addTxOptions } from './action.js';
import { clientFor, parseJson, serializeAction } from '../lib/tx.js';
export function createSignCommand() {
    const sign = new Command('sign');
    sign.description('Create and inspect signing requests');
    const request = sign.command('request <contract> <action> <data-json>');
    request.description('Create an ESR signing request for one action');
    request.option('--callback <url>', 'callback URL for wallets');
    request.option('--no-broadcast', 'request a signature without wallet broadcast');
    request.option('--qr', 'render a terminal QR code');
    addTxOptions(request).action(async (contract, actionName, dataJson, options) => {
        const client = clientFor(options.url);
        const info = await client.v1.chain.get_info();
        const action = await serializeAction({
            contract,
            action: actionName,
            data: parseJson(dataJson),
            authorization: options.auth,
            actor: options.actor,
            permission: options.permission,
            url: options.url,
        });
        const req = await SigningRequest.create({
            chainId: info.chain_id,
            action,
            broadcast: options.broadcast,
            callback: options.callback,
        }, { zlib });
        const uri = req.encode(true, false, 'esr:');
        if (options.qr && !options.json) {
            qrcode.generate(uri, { small: true });
        }
        if (options.json) {
            console.log(JSON.stringify({ uri }, null, 2));
            return;
        }
        console.log(uri);
    });
    return sign;
}
