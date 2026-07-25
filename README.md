# ACP adapter for Codex CLI

[![npm version](https://img.shields.io/npm/v/%40agentclientprotocol%2Fcodex-acp)](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)

Use [OpenAI Codex](https://github.com/openai/codex) from [Agent Client Protocol](https://agentclientprotocol.com/) clients.

`codex-acp` is a stdio ACP agent server. It starts the Codex App Server, translates ACP requests into Codex operations, and maps Codex events back into the client.

## Features

- ChatGPT, API key, and client-provided custom gateway authentication.
- Model, reasoning effort, fast mode, approval, and sandbox mode configuration.
- Text prompts, embedded context, images, resource links, and additional workspace directories.
- Shell command, file change, permission request, MCP tool call, terminal output, reasoning, plan, web search, image generation, image view, token usage, and review events.
- Subagent launches as standard ACP tool calls, with Codex thread identity and activity details in namespaced `_meta.codex.subagent` metadata.
- Ephemeral side conversations backed by Codex `thread/fork`, selected with `_meta.codex.sideChat`.
- Client-provided MCP servers over command-based stdio config and HTTP transport.
- Slash commands: `/status`, `/mcp`, `/skills`, `/review`, `/review-branch`, `/review-commit`, `/compact`, and `/logout`, as well as configured skills.

## Installation

Run the published package directly:

```bash
npx -y @agentclientprotocol/codex-acp
```

Or install it globally:

```bash
npm install -g @agentclientprotocol/codex-acp
codex-acp --version
```

The npm package includes a compatible `@openai/codex` dependency. Set `CODEX_PATH` only when you want the adapter to run a different Codex binary:

```bash
CODEX_PATH=/path/to/codex npx -y @agentclientprotocol/codex-acp
```

## Authentication

The adapter advertises ACP auth methods during initialization. Clients can authenticate with:

- ChatGPT login. Set `NO_BROWSER=1` to hide this method in remote or browserless environments.
- API key via `CODEX_API_KEY` or `OPENAI_API_KEY`.
- A custom OpenAI-compatible gateway, when the client opts in to the gateway auth capability.

## Runtime options

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config, including `model_provider`.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `agent`, or `agent-full-access`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.
- `JAZ_CODEX_MODEL_METADATA` - exact custom-provider model metadata used by Jaz; invalid or inconsistent metadata fails closed.

## Jaz fork

The `gluonfield/codex-acp-app-server` fork keeps Codex App Server as the runtime owner and adds the narrow compatibility needed by Jaz:

- side-chat output is routed to the parent ACP session with `_meta.codex.sideChat`;
- custom-provider context, modality, and reasoning metadata is carried without fallback guesses;
- native subagent activity stays in the official `_meta.codex` shapes for Jaz to translate at its client boundary;
- explicit non-OpenAI providers do not advertise or clear the user's shared Codex account credentials.

GitHub release archives contain the adapter and the exact `@openai/codex` runtime pinned by this package.

## Development

```bash
npm install
npm run start
npm run typecheck
npm test
```

Build standalone binaries in `dist/bin` with:

```bash
npm run bundle:all
```

See [readme-dev.md](readme-dev.md) for local client configuration, binary packaging, and Codex type regeneration.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
