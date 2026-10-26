import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules", "drizzle", "infra", "coverage", "cli/dist"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Agent-facing surfaces take actions through the guard, never the domain functions directly.
    files: ["src/mcp/server.ts", "src/http/routes/agent.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/domain/messaging.ts"],
              importNames: ["sendMessage"],
              message: "Use agentSendMessage from domain/guard.ts.",
            },
            {
              group: ["**/domain/groups.ts"],
              importNames: ["createGroup", "inviteToGroup"],
              message: "Use the agent* wrappers from domain/guard.ts.",
            },
            {
              group: ["**/domain/invitations.ts"],
              importNames: ["invitePerson"],
              message: "Use agentInvitePerson from domain/guard.ts.",
            },
            {
              group: ["**/domain/tool-calls.ts"],
              importNames: ["executeToolCall"],
              message: "Use agentCallTool from domain/guard.ts.",
            },
          ],
        },
      ],
    },
  },
  { files: ["*.js"], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
