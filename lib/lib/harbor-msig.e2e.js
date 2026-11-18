import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createPortServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ABI, Action, Checksum256, PrivateKey, PublicKey, Serializer, SignedTransaction, Transaction } from '@wharfkit/antelope';
import { publicKeyAuthority } from './deploy.js';
import { clientFor } from './tx.js';
const nodeos = process.env.HARBOR_NODEOS;
const harborSource = process.env.HARBOR_CHAIN_SOURCE;
if (!nodeos || !harborSource) {
    throw new Error('set HARBOR_NODEOS and HARBOR_CHAIN_SOURCE to the local Harbor binary and source checkout');
}
function loopbackPort(server) {
    const address = server.address();
    assert(address && typeof address === 'object' && address.address === '127.0.0.1');
    return address.port;
}
async function freePort() {
    const server = createPortServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = loopbackPort(server);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}
async function readContract(directory, name) {
    const [wasm, abi] = await Promise.all([
        fs.readFile(path.join(directory, name + '.wasm')),
        fs.readFile(path.join(directory, name + '.abi'), 'utf8'),
    ]);
    assert(WebAssembly.validate(wasm), `invalid ${name} test contract WASM`);
    return { wasm, abi: ABI.from(JSON.parse(abi)) };
}
async function run() {
    const [bios] = await Promise.all([
        readContract(path.join(harborSource, 'libraries/testing/contracts/old_versions/v1.7.0-develop-preactivate_feature/eosio.bios'), 'eosio.bios'),
        readContract(path.join(harborSource, 'unittests/contracts/eosio.msig'), 'eosio.msig'),
    ]);
    // The randomly generated bootstrap credential stays in this process. nodeos
    // requests block signatures from the test-owned loopback signing endpoint.
    const genesisKey = PrivateKey.generate('K1');
    const genesisPub = genesisKey.toPublic();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-cli-msig-'));
    const password = Buffer.from(randomBytes(32).toString('hex') + '\n');
    const signer = createServer(async (request, response) => {
        try {
            const body = [];
            for await (const chunk of request)
                body.push(chunk);
            const [digest, pub] = JSON.parse(Buffer.concat(body).toString());
            assert.equal(request.url, '/sign_digest');
            assert(genesisPub.equals(PublicKey.from(pub)));
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(genesisKey.signDigest(Checksum256.from(digest))));
        }
        catch {
            response.writeHead(400).end();
        }
    }).listen(0, '127.0.0.1');
    let producer;
    let producerLogs = '';
    try {
        await once(signer, 'listening');
        const port = await freePort();
        const url = `http://127.0.0.1:${port}`;
        const genesisFile = path.join(home, 'genesis.json');
        await fs.writeFile(genesisFile, JSON.stringify({
            initial_timestamp: new Date().toISOString().slice(0, -1),
            initial_key: String(genesisPub),
        }));
        producer = spawn(nodeos, [
            '--data-dir', path.join(home, 'data'), '--config-dir', path.join(home, 'config'),
            '--genesis-json', genesisFile, '--http-server-address', `127.0.0.1:${port}`,
            '--p2p-listen-endpoint', `127.0.0.1:${await freePort()}`,
            '--plugin', 'eosio::chain_api_plugin', '--plugin', 'eosio::producer_api_plugin',
            '--producer-name', 'eosio', '--enable-stale-production', '--keosd-provider-timeout', '1000',
            '--signature-provider', `${genesisPub}=KEOSD:http://127.0.0.1:${loopbackPort(signer)}/sign_digest`,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        producer.on('error', (error) => { producerLogs += String(error); });
        producer.stderr?.on('data', (chunk) => { producerLogs = (producerLogs + chunk).slice(-6000); });
        producer.stdout?.resume();
        const client = clientFor(url);
        let chainId;
        for (let attempt = 0; attempt < 80 && !chainId && producer.exitCode === null; attempt++) {
            try {
                const info = await client.v1.chain.get_info();
                if (info.head_block_num.toNumber() > 1)
                    chainId = String(info.chain_id);
            }
            catch {
                // Wait for the dedicated fixture to finish starting.
            }
            if (!chainId)
                await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert(chainId, 'local Harbor fixture failed to produce blocks');
        const info = await client.v1.chain.get_info();
        console.log(`Local Harbor chain ${chainId}, nodeos ${info.server_version_string}`);
        const features = await fetch(url + '/v1/producer/get_supported_protocol_features', { method: 'POST', body: '{}' });
        assert(features.ok, 'unable to read supported chain features');
        const supported = await features.json();
        const feature = supported.find(({ specification }) => specification.some(({ value }) => value === 'PREACTIVATE_FEATURE'));
        assert(feature, 'Harbor lacks PREACTIVATE_FEATURE');
        const activation = await fetch(url + '/v1/producer/schedule_protocol_feature_activations', {
            method: 'POST', body: JSON.stringify({ protocol_features_to_activate: [feature.feature_digest] }),
        });
        assert(activation.ok, 'unable to schedule PREACTIVATE_FEATURE');
        for (let attempt = 0; attempt < 20; attempt++) {
            const activated = await client.v1.chain.get_activated_protocol_features();
            if (activated.activated_protocol_features.some((value) => String(value.feature_digest) === feature.feature_digest))
                break;
            if (attempt === 19)
                throw new Error('PREACTIVATE_FEATURE was not activated');
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        async function bootstrap(...actions) {
            const latest = await client.v1.chain.get_info();
            const transaction = Transaction.from({
                ...latest.getTransactionHeader(),
                actions: actions.map(({ name, data }) => Action.from({
                    account: 'eosio', name, authorization: [{ actor: 'eosio', permission: 'active' }], data,
                }, bios.abi)),
            });
            const signatures = [genesisKey.signDigest(transaction.signingDigest(chainId))];
            await client.v1.chain.push_transaction(SignedTransaction.from({ ...transaction, signatures }));
        }
        await bootstrap({ name: 'setcode', data: { account: 'eosio', vmtype: 0, vmversion: 0, code: bios.wasm.toString('hex') } }, { name: 'setabi', data: { account: 'eosio', abi: Serializer.encode({ object: bios.abi }).hexString } });
        // Pre-activate the protocol dependencies required by modern eosio.msig.
        const activated = new Set([feature.feature_digest]);
        while (activated.size < supported.length) {
            const eligible = supported.filter((candidate) => !activated.has(candidate.feature_digest) && candidate.dependencies.every((dependency) => activated.has(dependency)));
            assert(eligible.length, 'unable to order Harbor protocol dependencies');
            await bootstrap(...eligible.map(({ feature_digest }) => ({ name: 'activate', data: { feature_digest } })));
            eligible.forEach(({ feature_digest }) => activated.add(feature_digest));
            await new Promise((resolve) => setTimeout(resolve, 550));
        }
        async function cli(args, fail) {
            const child = spawn(process.execPath, ['lib/index.js', ...args], {
                env: {
                    ...process.env, HARBOR_HOME: path.join(home, 'wallet'), HARBOR_API_URL: url,
                    HARBOR_ACTOR: undefined, HARBOR_PERMISSION: 'active', HARBOR_MSIG_CONTRACT: 'eosio.msig',
                    HARBOR_PRIVATE_KEY: undefined, WHARFKIT_DEPLOY_KEY: undefined, HARBOR_KEY_PASSWORD_FD: '3',
                },
                stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
            });
            const secretPipe = child.stdio[3];
            secretPipe.on('error', () => { });
            secretPipe.end(password);
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (chunk) => { stdout += chunk; });
            child.stderr?.on('data', (chunk) => { stderr += chunk; });
            const [code] = await once(child, 'close');
            if (fail) {
                assert.notEqual(code, 0);
                assert.match(stderr, fail);
                return;
            }
            assert.equal(code, 0, `${args.slice(0, 2).join(' ')} failed: ${stderr}`);
            return JSON.parse(stdout);
        }
        const members = ['signerone', 'signertwo', 'signerthree'];
        const keys = [];
        for (const [index, account] of members.entries()) {
            const key = await cli(['keys', 'create', account, '--storage', 'encrypted', '--type', index === 1 ? 'K1' : 'R1', '--json']);
            assert.equal(key.storage, 'encrypted');
            keys.push(key.publicKey);
        }
        assert(keys[0].startsWith('PUB_R1_'));
        const operator = await cli(['keys', 'create', 'operator', '--type', 'K1', '--json']);
        const bootstrapAccounts = [
            ...members.map((name, index) => ({ name, key: keys[index] })),
            { name: 'operator', key: operator.publicKey },
        ];
        await bootstrap(...bootstrapAccounts.map(({ name, key }) => ({
            name: 'newaccount',
            data: { creator: 'eosio', name, owner: publicKeyAuthority(String(genesisPub)), active: publicKeyAuthority(key) },
        })));
        await bootstrap(...['eosio.msig', 'treasury'].map((name) => ({
            name: 'newaccount',
            data: { creator: 'eosio', name, owner: publicKeyAuthority(operator.publicKey), active: publicKeyAuthority(operator.publicKey) },
        })));
        await cli([
            'contract', 'deploy', '--account', 'eosio.msig', '--key', 'operator', '--validate', '--json',
            '--wasm', path.join(harborSource, 'unittests/contracts/eosio.msig/eosio.msig.wasm'),
            '--abi', path.join(harborSource, 'unittests/contracts/eosio.msig/eosio.msig.abi'),
        ]);
        assert((await client.v1.chain.get_abi('eosio.msig')).abi?.actions.some(({ name }) => String(name) === 'exec'));
        await bootstrap({ name: 'setpriv', data: { account: 'eosio.msig', is_priv: 1 } });
        await cli(['account', 'create', 'operator', 'r1created', '--owner-key', keys[1], '--active-key', keys[0], '--key', 'operator', '--json']);
        const r1Account = await cli(['account', 'info', 'r1created', '--json']);
        assert.equal(r1Account.permissions.find(({ perm_name }) => perm_name === 'active').required_auth.keys[0].key, keys[0]);
        const data = JSON.stringify({ from: 'r1created' });
        const unsigned = await cli(['action', 'sign', 'eosio', 'reqauth', data, '--actor', 'r1created', '--key', members[0], '--json']);
        const signed = SignedTransaction.from(unsigned.transaction);
        assert(signed.signatures[0].verifyDigest(signed.transaction.signingDigest(chainId), PublicKey.from(keys[0])));
        const signedFile = path.join(home, 'signed.json');
        await fs.writeFile(signedFile, JSON.stringify(unsigned));
        const coSigned = await cli(['sign', 'transaction', signedFile, '--chain-id', chainId, '--key', members[1]]);
        assert.equal(coSigned.transaction.signatures.length, 2);
        const pushed = await cli(['action', 'push', 'eosio', 'reqauth', data, '--actor', 'r1created', '--key', members[0], '--json']);
        assert.equal(pushed.status, 'executed');
        console.log(`PUB_R1 account authority and R1-signed transaction verified: ${pushed.transaction_id}`);
        const authority = JSON.stringify({
            threshold: 2,
            accounts: members.map((member) => ({ permission: `${member}@active`, weight: 1 })),
        });
        await cli(['account', 'set-permission', 'treasury', 'active', 'owner', authority, '-p', 'owner', '-k', 'operator', '--json']);
        const actionData = JSON.stringify({
            account: 'treasury', permission: 'receipt', parent: 'active', auth: publicKeyAuthority(keys[0]),
        });
        const proposed = await cli([
            'msig', 'propose', 'rehearsal', 'eosio', 'updateauth', actionData, '--actor', 'operator', '--key', 'operator',
            '--action-auth', 'treasury@active', '--requested', members.map((member) => `${member}@active`).join(','), '--json',
        ]);
        const shown = await cli(['msig', 'show', 'operator', 'rehearsal']);
        assert.equal(shown.transaction.actions[0].data.permission, 'receipt');
        const approval = (index, hash) => [
            'msig', 'approve', 'operator', 'rehearsal', `${members[index]}@active`,
            '--proposal-hash', hash, '--key', members[index], '--json',
        ];
        await cli(approval(0, '00'.repeat(32)), /hash|sha256/i);
        const first = await cli(approval(0, shown.proposal_hash));
        const exec = ['msig', 'exec', 'operator', 'rehearsal', '--actor', 'operator', '--key', 'operator', '--json'];
        await cli(exec, /transaction authorization failed/);
        const second = await cli(approval(1, shown.proposal_hash));
        const completed = await cli(exec);
        assert.equal(completed.status, 'executed');
        const treasury = await client.v1.chain.get_account('treasury');
        const receipt = treasury.permissions.find(({ perm_name }) => String(perm_name) === 'receipt');
        assert.equal(receipt?.required_auth.keys[0].key.toString(), keys[0]);
        await cli(['msig', 'show', 'operator', 'rehearsal'], /proposal not found/);
        console.log(`2-of-3 proved (one approval rejected, two executed): ${proposed.transaction_id}, ${first.transaction_id}, ${second.transaction_id}, ${completed.transaction_id}`);
    }
    catch (error) {
        if (producerLogs)
            process.stderr.write(producerLogs + '\n');
        throw error;
    }
    finally {
        if (producer?.pid && producer.exitCode === null && producer.signalCode === null) {
            const exited = once(producer, 'close');
            const kill = setTimeout(() => producer?.kill('SIGKILL'), 5000);
            producer.kill('SIGTERM');
            await exited;
            clearTimeout(kill);
        }
        await new Promise((resolve) => signer.close(() => resolve()));
        genesisKey.data.array.fill(0);
        password.fill(0);
        await fs.rm(home, { recursive: true });
    }
}
await run();
