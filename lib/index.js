import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { WebError } from "@deepseek-ai/dsh-web";
//#region lib/types/provider.js
/**
* DuckDuckGo search without keys or infrastructure: parse the public HTML and
* Lite result pages the way battle-tested scraping clients do. The `html`
* endpoint is queried with a form POST, the `lite` endpoint with GET; in
* `auto` mode a failed or empty attempt falls through to the other one.
*
* This reads DuckDuckGo's rendered page — an unofficial surface that may
* change shape or throttle datacenter IPs. From a desktop environment it is
* the most reliable keyless option; a self-hosted SearXNG stays the robust
* choice for automation-heavy use (see @local/dsh-web-search-searxng).
* @module @deepseek-ai/dsh-web-search-duckduckgo/provider
*/
/** Stable id this provider registers under. */
const DUCKDUCKGO_PROVIDER_ID = "duckduckgo";
/** Default per-request backstop; the tool layer owns its own longer timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
/** Default provider-side source cap when a request carries no bound of its own. */
const DEFAULT_MAX_RESULTS = 20;
/** Browser-like attribution: DuckDuckGo throttles generic clients harder. */
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
/** Endpoint order tried by `auto`. */
const AUTO_ENDPOINTS = ["html", "lite"];
/** Wire values of the html endpoint's `kp` safesearch parameter. */
const SAFESEARCH_Kp = { 0: "-2", 1: "-1", 2: "1" };
/** Wire values of the html endpoint's `df` recency parameter. */
const TIME_RANGE_DF = { day: "d", week: "w", month: "m", year: "y" };
/**
* Decode HTML entities after stripping tags; `&amp;` last so escaped escapes
* do not double-decode. Collapses whitespace runs the markup scatters.
* @param html - raw inner HTML of a title/snippet node.
* @returns clean single-line plain text.
*/
function plainText(html) {
	return decodeEntities(html.replace(/<[^>]*>/gu, "")).replace(/\s+/gu, " ").trim();
}
function decodeEntities(text) {
	return text.replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/&#(\d+);/gu, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10))).replace(/&quot;/gu, "\"").replace(/&apos;/gu, "'").replace(/&nbsp;/gu, " ").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
}
/**
* Resolve one anchor href to a real target URL, unwrapping DuckDuckGo's
* `/l/?uddg=<encoded>` redirect wrapper and protocol-relative forms.
* @param href - raw href attribute value (entity-encoded).
* @returns an absolute http(s) URL, or undefined when unusable.
*/
function targetUrlOf(href) {
	let value = decodeEntities(String(href).trim());
	if (!/^https?:\/\//iu.test(value)) {
		if (value.startsWith("//")) value = `https:${value}`;
		else if (value.startsWith("/")) value = `https://duckduckgo.com${value}`;
	}
	try {
		const url = new URL(value);
		if (/(^|\.)duckduckgo\.com$/iu.test(url.hostname) && url.pathname === "/l/") {
			const unwrapped = url.searchParams.get("uddg");
			if (unwrapped !== null && /^https?:\/\//iu.test(unwrapped)) return unwrapped;
			return void 0;
		}
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : void 0;
	} catch {
		return void 0;
	}
}
/** Collect every regex match's capture array. */
function matches(pattern, body) {
	return [...body.matchAll(pattern)];
}
/**
* Parse one results page into normalized sources. Titles come from the
* result anchors, snippets from the i-th snippet node when one lines up.
* Works for both endpoint shapes (class names differ, structure matches).
* @param body - response body text.
* @param linkPattern - result-anchor pattern with href + inner captures.
* @param snippetPattern - snippet-body pattern with one inner capture.
* @returns deduped sources in page order.
*/
function parsePage(body, linkPattern, snippetPattern) {
	const links = matches(linkPattern, body).map((match) => ({
		url: targetUrlOf(match[1]),
		title: plainText(match[2])
	}));
	const snippets = matches(snippetPattern, body).map((match) => plainText(match[1]));
	const seen = new Set();
	const sources = [];
	for (const [index, link] of links.entries()) {
		if (link.url === void 0 || seen.has(link.url)) continue;
		seen.add(link.url);
		const snippet = snippets[index];
		sources.push({
			url: link.url,
			...link.title.length > 0 ? { title: link.title } : {},
			...(snippet !== void 0 && snippet.length > 0 ? { snippet } : {})
		});
	}
	return sources;
}
const HTML_LINK_PATTERN = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu;
const HTML_SNIPPET_PATTERN = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/gu;
const LITE_LINK_PATTERN = /<a\b[^>]*class=["'][^"']*\bresult-link\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gu;
const LITE_SNIPPET_PATTERN = /class=["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/gu;
/**
* Build one candidate fetch against one endpoint kind.
* @param kind - "html" (form POST) or "lite" (GET).
* @param request - the search request.
* @param options - resolved provider options.
* @returns fetch init plus the parser pair for this endpoint.
*/
function candidateFetch(kind, request, options) {
	const params = new URLSearchParams();
	params.set("q", request.query);
	if (options.language.length > 0) params.set("kl", options.language);
	const kp = SAFESEARCH_Kp[options.safesearch];
	if (kp !== void 0) params.set("kp", kp);
	const df = TIME_RANGE_DF[options.timeRange];
	if (df !== void 0) params.set("df", df);
	const headers = {
		accept: "text/html",
		"user-agent": options.userAgent,
		...options.acceptLanguage.length > 0 ? { "accept-language": options.acceptLanguage } : {}
	};
	if (kind === "html") return {
		url: stripTrailingSlash(options.htmlEndpointURL),
		init: {
			method: "POST",
			headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
			body: params.toString()
		},
		linkPattern: HTML_LINK_PATTERN,
		snippetPattern: HTML_SNIPPET_PATTERN
	};
	return {
		url: `${stripTrailingSlash(options.liteEndpointURL)}/?${params.toString()}`,
		init: { method: "GET", headers },
		linkPattern: LITE_LINK_PATTERN,
		snippetPattern: LITE_SNIPPET_PATTERN
	};
}
/** The DuckDuckGo-backed search provider. */
var DuckDuckGoSearchProvider = class {
	resolveOptions;
	id = DUCKDUCKGO_PROVIDER_ID;
	/**
	* @param resolveOptions - the options for the NEXT operation, snapshotted
	* once at each operation's entry so one search never mixes two sections.
	*/
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}
	available() {
		return true;
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		throwIfSearchAborted(signal);
		const kinds = options.endpoint === "auto" ? AUTO_ENDPOINTS : [options.endpoint];
		let lastStatusError = null;
		for (const kind of kinds) {
			const candidate = candidateFetch(kind, request, options);
			options.recordRequest?.({
				endpoint: candidate.url,
				method: candidate.init.method
			});
			let response;
			try {
				response = await fetch(candidate.url, {
					...candidate.init,
					...signal !== void 0 ? { signal: boundedSignal(signal, options.requestTimeoutMs) } : {}
				});
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
				lastStatusError = new WebError(`DuckDuckGo ${kind} request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
				continue;
			}
			if (!response.ok) {
				lastStatusError = new WebError(`DuckDuckGo ${kind} responded HTTP ${response.status} (the endpoint may be throttling or reshaping)`, "WEB_PROVIDER_ERROR");
				continue;
			}
			let bodyText;
			try {
				bodyText = await response.text();
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
				lastStatusError = new WebError(`DuckDuckGo ${kind} body read failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
				continue;
			}
			const sources = cappedSources(parsePage(bodyText, candidate.linkPattern, candidate.snippetPattern), request, options.maxResults);
			// An empty page on one endpoint usually means throttling or a markup
			// shift, not a genuinely empty result set — fall through to the next.
			if (sources.length === 0 && kinds.length > 1) {
				lastStatusError = null;
				continue;
			}
			return {
				sources,
				truncated: false
			};
		}
		throw lastStatusError ?? new WebError("DuckDuckGo returned no usable results", "WEB_PROVIDER_ERROR");
	}
};
/** Drop one trailing slash so endpoint URLs compose cleanly. */
function stripTrailingSlash(url) {
	return url.replace(/\/+$/u, "");
}
/** Apply the request's own bound on top of the configured cap. */
function cappedSources(sources, request, cap) {
	const limit = Math.min(typeof request.maxResults === "number" && Number.isFinite(request.maxResults) ? request.maxResults : cap, cap);
	return limit < sources.length ? sources.slice(0, limit) : sources;
}
/** Cap one search behind the caller's signal AND a per-request backstop timer. */
function boundedSignal(signal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (typeof AbortSignal.any !== "function") return timeout;
	return AbortSignal.any([signal, timeout]);
}
/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}
/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("DuckDuckGo search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
//#endregion
//#region lib/types/index.js
/**
* Register a keyless DuckDuckGo-backed search provider in `ctx.web`. Pairs
* naturally with @local/dsh-web-search-searxng: switch the `web` row's
* `searchProvider` between `"duckduckgo"` (zero infrastructure) and
* `"searxng"` (self-hosted, automation-friendly) at any time.
* @module @local/dsh-web-search-duckduckgo
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-duckduckgo";
/** The web seam this provider registers into. */
const inject = ["web"];
const Config = z.object({
	endpoint: z.union(["auto", "html", "lite"]),
	language: z.string(),
	safesearch: z.number().step(1).min(0).max(2),
	timeRange: z.string(),
	maxResults: z.number().step(1).min(1),
	requestTimeoutMs: z.number().step(1).min(1000),
	userAgent: z.string(),
	acceptLanguage: z.string()
});
/** Settings namespace carrying this provider's query defaults. */
const WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE = settingsNamespace("web-search-duckduckgo");
/**
* Project one resolved section into the options the provider serves its next
* search with; every value it reads is already fully defaulted.
* @param ctx - plugin context.
* @param config - the currently authoritative section.
* @returns options for one search.
*/
function resolveOptions(ctx, config) {
	return {
		endpoint: config.endpoint ?? "auto",
		language: config.language ?? "",
		safesearch: config.safesearch ?? 1,
		timeRange: config.timeRange ?? "",
		maxResults: config.maxResults ?? DEFAULT_MAX_RESULTS,
		requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
		acceptLanguage: config.acceptLanguage ?? "",
		/** Endpoint bases (fixed public surfaces; overridable for tests). */
		htmlEndpointURL: "https://html.duckduckgo.com/html",
		liteEndpointURL: "https://lite.duckduckgo.com/lite",
		recordRequest: (request) => {
			ctx.get("agents")?.currentInitiator()?.session.append("web/duckduckgo-search-request", request);
		}
	};
}
/** Register the DuckDuckGo search provider with `ctx.web`. */
function apply(ctx, config) {
	let current = () => config;
	installSettingsSection(ctx, WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {}
	});
	ctx.web.registerSearchProvider(new DuckDuckGoSearchProvider(() => ({
		...resolveOptions(ctx, current())
	})));
}
export { Config, DUCKDUCKGO_PROVIDER_ID, DEFAULT_MAX_RESULTS, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_USER_AGENT, DuckDuckGoSearchProvider, WEB_SEARCH_DUCKDUCKGO_SETTINGS_NAMESPACE, apply, inject, name, plainText, resolveOptions, targetUrlOf };
