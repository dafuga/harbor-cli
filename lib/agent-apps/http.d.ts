export declare function sha256(value: string | Uint8Array): string;
export declare function serviceUrl(value: unknown, label: string): URL;
export declare function responseBytes(response: Response, maximum: number): Promise<Buffer<ArrayBuffer>>;
export declare function postJson(url: URL, body: string, options?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeout?: number;
}): Promise<{
    raw: string;
    data: Record<string, unknown>;
}>;
