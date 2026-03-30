declare module 'node-media-server' {
  interface NMSConfig {
    rtmp?: {
      port?: number;
      chunk_size?: number;
      gop_cache?: boolean;
      ping?: number;
      ping_timeout?: number;
    };
    http?: {
      port?: number;
      allow_origin?: string;
    };
  }

  class NodeMediaServer {
    constructor(config: NMSConfig);
    run(): void;
    stop(): void;
    on(event: string, listener: (...args: any[]) => void): void;
    getSession(id: string): { reject: () => void };
  }

  export = NodeMediaServer;
}
