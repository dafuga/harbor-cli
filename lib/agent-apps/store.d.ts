type Value = string | number | null;
type Table = 'agents' | 'routines' | 'quotes' | 'runs' | 'feedback';
export declare class AgentStore {
    private database;
    constructor(file: string);
    private get db();
    close(): void;
    bind(identity: string): void;
    transaction<T>(operation: () => T): T;
    get<T>(table: Table, id: string): T | undefined;
    set<T extends {
        id: string;
    }>(table: Table, value: T): T;
    query<T>(sql: string, ...params: Value[]): T[];
    run(sql: string, ...params: Value[]): void;
    totals(agentId: string): {
        paid: number;
        reserved: number;
    };
}
export {};
