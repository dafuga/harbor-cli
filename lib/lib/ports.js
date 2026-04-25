import net from 'node:net';
export async function canConnect(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        socket.setTimeout(1000);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', () => resolve(false));
    });
}
