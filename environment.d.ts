declare global {
    namespace NodeJS {
        interface ProcessEnv {
            NODE_ENV: "development" | "production";
            REDIS_PORT: string;
            PORT?: number;
        }
    }
}

export {};
