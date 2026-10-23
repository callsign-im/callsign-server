export const testEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? "postgres://callsign:callsign@localhost:5433/callsign_test",
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6380/1",
  SMTP_URL: process.env.TEST_SMTP_URL ?? "smtp://localhost:1025",
  MAILPIT_URL: process.env.TEST_MAILPIT_URL ?? "http://localhost:8025",
  PUBLIC_API_URL: "http://localhost:8080",
  WEB_URL: "http://localhost:3000",
  ENCRYPTION_KEY: "nG3BpYl+rMlnT/vTjRklnDQWbqQuaDUYDEZ4PJl5oII=",
};
