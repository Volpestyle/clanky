declare module "mineflayer" {
  const mineflayer: {
    createBot(options: Record<string, unknown>): unknown;
  };
  export default mineflayer;
}

declare module "mineflayer-pathfinder" {
  export const pathfinder: (bot: unknown) => void;
  export class Movements {
    constructor(bot: unknown);
    canDig?: boolean;
  }
  export const goals: {
    GoalNear: new (x: number, y: number, z: number, range: number) => unknown;
    GoalFollow: new (entity: { position: unknown }, range: number) => unknown;
  };
  const pkg: {
    pathfinder: typeof pathfinder;
    Movements: typeof Movements;
    goals: typeof goals;
  };
  export default pkg;
}

declare module "mineflayer-collectblock" {
  export const plugin: (bot: unknown) => void;
  const pkg: {
    plugin: typeof plugin;
  };
  export default pkg;
}

declare module "mineflayer-pvp" {
  export const plugin: (bot: unknown) => void;
  const pkg: {
    plugin: typeof plugin;
  };
  export default pkg;
}

declare module "mineflayer-tool" {
  export const plugin: (bot: unknown) => void;
  const pkg: {
    plugin: typeof plugin;
  };
  export default pkg;
}

declare module "vec3" {
  export class Vec3 {
    constructor(x: number, y: number, z: number);
    x: number;
    y: number;
    z: number;
    distanceTo(other: Vec3): number;
  }
}

declare module "@modelcontextprotocol/sdk/server/index.js" {
  export class Server {
    constructor(info: { name: string; version: string }, options: { capabilities: { tools: Record<string, never> } });
    setRequestHandler(schema: unknown, handler: (request: any) => Promise<any>): void;
    connect(transport: unknown): Promise<void>;
    onerror?: (error: unknown) => void;
  }
}

declare module "@modelcontextprotocol/sdk/server/stdio.js" {
  export class StdioServerTransport {}
}

declare module "@modelcontextprotocol/sdk/types.js" {
  export const CallToolRequestSchema: unknown;
  export const ListToolsRequestSchema: unknown;

  export type CallToolRequest = {
    params: {
      name: string;
      arguments?: Record<string, unknown>;
    };
  };
}


declare module "node:events" {
  export function once(emitter: { once(event: string, listener: (...args: unknown[]) => void): void }, event: string): Promise<unknown[]>;
}

declare const process: {
  env: Record<string, string | undefined>;
  stderr: {
    write(chunk: string): void;
  };
  on(event: string, listener: () => void | Promise<void>): void;
  exit(code?: number): never;
};
