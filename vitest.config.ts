import { defineConfig } from "vitest/config";
import { testEnv } from "./test/env.ts";

export default defineConfig({
  test: {
    env: testEnv,
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
