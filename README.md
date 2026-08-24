# @local/dsh-web-search-duckduckgo — keyless DuckDuckGo search provider for DeepSeek Harness

Registers a **DuckDuckGo-backed search provider** into the harness web
capability seam (`ctx.web`) so the built-in `web_search` tool works with **no
API key and no infrastructure**: the plugin queries DuckDuckGo's public HTML
and Lite result pages and parses them — the same approach battle-tested
scraping clients use.

Pairs with `@local/dsh-web-search-searxng`: **DuckDuckGo needs nothing
running** (best default), while a self-hosted SearXNG stays the sturdier
choice for automation-heavy use. Switch between them by editing one line in
the profile patch.

## How it fits

Implements the standard provider face (`id`, cheap `available()`,
`search(request, signal)` → `{ sources[], truncated }`):

- two endpoint kinds: the `html` page (form POST) and the `lite` page (GET);
  `endpoint: "auto"` tries html first and falls through to lite on failure or
  an empty parse;
- titles/snippets are tag-stripped and entity-decoded; `/l/?uddg=…` redirect
  wrappers are unwrapped back to target URLs; results dedupe in rank order;
- query options ride the wire: `kl` region, `kp` safesearch (`0/1/2` →
  `-2/-1/1`), `df` recency (`day/month/year`);
- the request's own `maxResults` and the configured cap are both honored;
  cancellation surfaces as the seam's stable `WEB_ABORTED`.

Caveat kept honest: this reads a rendered page, not a contract API. From a
desktop IP it is dependable; if DuckDuckGo throttles or reshapes, failures
surface as `WEB_PROVIDER_ERROR` with the endpoint named — switch to SearXNG
for those workloads.

## Install / update

Source lives here; the installed copy goes into the shared profile tree:

```sh
cp -R lib package.json ~/.dsh/profiles/node_modules/@local/dsh-web-search-duckduckgo/
```

Registration goes into `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: web-search-duckduckgo
      name: '@local/dsh-web-search-duckduckgo'

# Select it for the search capability (replaces the whole `web` row config,
# whose only owned key is searchProvider):
- id: web
  config:
    searchProvider: duckduckgo
```

Then restart `dsh web`. Flip the value to `"searxng"` or `"deepseek-official"`
to route searches elsewhere.

## Config

| Field              | Default                | Meaning                                        |
| ------------------ | ---------------------- | ---------------------------------------------- |
| `endpoint`         | `auto`                 | `auto` / `html` / `lite`                        |
| `language`         | `""`                   | DDG region, e.g. `ru-ru`, `en-us`; empty = all  |
| `safesearch`       | `1`                    | `0` off · `1` moderate · `2` strict             |
| `timeRange`        | `""`                   | `day` / `month` / `year`; empty = any           |
| `maxResults`       | `20`                   | Provider-side source cap                        |
| `requestTimeoutMs` | `15000`                | Per-request backstop timer                      |
| `userAgent`        | Chrome-like UA string  | DuckDuckGo throttles generic clients harder     |
| `acceptLanguage`   | `""`                   | e.g. `ru,en`                                    |

Editable live from the harness settings UI under the `web-search-duckduckgo`
namespace; each search snapshots the current section.

## Checks

```sh
node test/smoke.mjs   # helpers, parsing, auto-fallback, caps, failures, abort
```

(The test symlinks `node_modules` at the profile tree when present so the
plugin's `@deepseek-ai/*` imports resolve outside the installed location.)
