export function normalizeUrl(url) {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}
export async function getTableRows(url, contract, table, options = {}) {
    const response = await fetch(`${normalizeUrl(url)}/v1/chain/get_table_rows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            json: true,
            code: contract,
            scope: options.scope ?? contract,
            table,
            limit: options.limit ?? 100,
        }),
    });
    if (!response.ok) {
        throw new Error(`get_table_rows ${contract}::${table} failed: ${response.status}`);
    }
    return (await response.json());
}
export function parseAssetAmount(asset) {
    const [amount] = asset.split(' ');
    return Number(amount);
}
export function assetSymbol(asset) {
    const [, symbol] = asset.split(' ');
    return symbol ?? '';
}
export function isActive(value) {
    return value === true || value === 1;
}
