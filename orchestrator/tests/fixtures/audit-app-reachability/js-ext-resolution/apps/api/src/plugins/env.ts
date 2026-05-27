export interface AppConfig {
  port: number;
}

export function buildAppConfig(): AppConfig {
  return { port: 3001 };
}
