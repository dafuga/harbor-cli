const guestInterfaces = ['/dev/sev-guest', '/sys/kernel/config/tsm/report'];
export async function sealedGuestPreflight(options) {
    if (options.platform !== 'linux' || options.arch !== 'x64') {
        throw new TypeError('sealedcompute requires a Linux x64 SEV-SNP or TDX guest');
    }
    if (!options.hasConfig) {
        throw new TypeError('sealedcompute requires an existing provider config with --config <path>');
    }
    const available = await Promise.all(guestInterfaces.map((device) => options.canAccess(device)));
    if (!available.includes(true)) {
        throw new TypeError(`sealedcompute guest interfaces are unavailable: ${guestInterfaces.join(', ')}`);
    }
}
