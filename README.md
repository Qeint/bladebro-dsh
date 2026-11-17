# bladebro-dsh

First-class [Bladebro](https://github.com/dondai44423/bladebro) agentic browser driver for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). One install line gives every dsh profile all five Bladebro tools (`act`, `see`, `state`, `run`, `vision`) plus `bladebro_status` (`bladebro doctor`), backed by a supervised, SHA256-verified, auto-updating native binary.

Designed as the direct browser companion to [`donsetch-dsh`](https://github.com/dondai44423/donsetch-dsh): both bundles compose cleanly in the same `dsh` profile with zero host-train runtime dependencies.

## Install

```bash
dsh plugin --profile web add github:Qeint/bladebro-dsh
```

Restart `dsh web` (bundle plugins activate on the next boot). On first start the plugin downloads the platform Bladebro binary from GitHub Releases, verifies its SHA256 against the release `.sha256` sidecar, and registers the tools in-process.

## Tools Registered

- `bladebro_act`: click, type, fill forms in one call, select, press, scroll, hover, navigate, upload, download, wait, eval, batch, PDF export, and tab navigation
- `bladebro_see`: token-efficient `model` (interactive refs), `content` (rendered markdown), `outline`, `extract` (`auto`, `json`, `links`, `forms`), and `logs` (`console`, `network`, `xhr`)
- `bladebro_state`: cookies, localStorage, sessionStorage, tabs, session save/load, and resource blocking
- `bladebro_run`: multi-step conditional (`if` / `while`) browser programs in a single round-trip
- `bladebro_vision`: screenshot capture (with optional Set-of-Marks ref badges) passed straight through as MCP image content blocks
- `bladebro_status`: live daemon state, browser home, registered tools, and `bladebro doctor` diagnostics

## Why a Native Bundle Plugin Instead of Raw MCP Config

| | built-in MCP config | `bladebro-dsh` |
| --- | --- | --- |
| Install | manual config + binary install | one `dsh plugin add` |
| Binary download + SHA256 verify | manual | automatic from GitHub Releases |
| Auto-updates with Bladebro releases | never | throttled check, swapped safely between calls |
| Tool names | `mcp__bladebro__...` | `bladebro_...` |
| Config file changes (`config.toml`) | restart harness | live daemon swap on file change |
| Workbench cards | generic | per-action call/result summaries + screenshot blocks |
| Self-diagnostics | none | `bladebro_status` (`bladebro doctor`) |
| Schema wire safety | unvalidated | projected into the enforced raw JSON Schema subset |

## Configuration

Override via `$DSH_HOME/cordis.patch.yml` or environment variables:

| option | default | description |
| --- | --- | --- |
| `toolPrefix` | `bladebro` | Model-facing tool prefix, `[A-Za-z0-9_-]{1,16}` |
| `channel` | `stable` | Update channel (`stable` or `latest`) |
| `autoUpdate` | `true` | Download + SHA256-verify newer Bladebro releases and swap between calls |
| `updateIntervalHours` | `24` | Minimum hours between update checks |
| `callTimeoutMs` | `180000` | Base per-call MCP timeout (extended automatically when `timeout` or `run` steps specify larger budgets) |
| `bootTimeoutMs` | `25000` | Daemon `initialize` + `tools/list` timeout |
| `fallbackToPath` | `true` | Fall back to `bladebro` on `PATH` when offline (reported honestly as `degraded` in `bladebro_status`) |
| `pinnedVersion` | `4.6.9` | Minimum Bladebro release floor |

Environment variables: `BLADEBRO_DSH_PREFIX`, `BLADEBRO_DSH_CHANNEL`, `BLADEBRO_DSH_AUTOUPDATE=off`, `BLADEBRO_BIN`, `BLADEBRO_DSH_CACHE_DIR`, `BLADE_HOME`.

## Development

```bash
npm install
npm test        # build + unit/integration suite
npm run lint    # no em-dashes house rule
npm run pack-check
npm run live    # live MCP parity against a real bladebro binary + Chromium
```

## License

Apache-2.0, matching [Bladebro](https://github.com/dondai44423/bladebro).
