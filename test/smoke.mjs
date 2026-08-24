// Smoke test: unit-check the HTML helpers, then exercise the provider over a
// local HTTP stand-in serving DuckDuckGo-shaped pages: html parsing, lite
// fallback, caps, failure propagation, and caller cancellation.
import assert from "node:assert";
import { createServer } from "node:http";

const mod = await import(new URL("../lib/index.js", import.meta.url));
assert.equal(mod.name, "web-search-duckduckgo");
assert.deepEqual(mod.inject, ["web"]);
assert.equal(typeof mod.apply, "function");

// ── helper units ─────────────────────────────────────────────────────────────
assert.equal(mod.plainText("<b>Cat &amp;</b>&#160;&#x27;s&nbsp;&lt;stuff&gt;"), "Cat & 's <stuff>");
assert.equal(mod.targetUrlOf("https://direct.example/a?x=1&amp;y=2"), "https://direct.example/a?x=1&y=2");
assert.equal(mod.targetUrlOf("//duckduckgo.com/l/?uddg=https%3A%2F%2Fwrapped.example%2Fp%3Fid%3D7&rut=abc"), "https://wrapped.example/p?id=7");
assert.equal(mod.targetUrlOf("/l/?uddg=%2Frelative"), void 0);
assert.equal(mod.targetUrlOf("javascript:void(0)"), void 0);

// ── apply() wiring against a stub seam ──────────────────────────────────────
let registered = null;
const ctx = {
	web: { registerSearchProvider(provider) {
		registered = provider;
	} },
	inject() {},
	get: () => void 0
};
mod.apply(ctx, {});
assert.ok(registered && registered.id === "duckduckgo");
assert.equal(registered.available(), true);

// ── local DuckDuckGo stand-in ────────────────────────────────────────────────
const seenRequests = [];
/** Minimal html-endpoint page: two hits (one uddg-wrapped), a duplicate, junk. */
const HTML_PAGE = `<html><body>
<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fone%3Fx%3D1">Cat &amp; Dog <b>guide</b></a></h2>
<a class="result__snippet" href="#">snippy <em>first</em> &amp; &#39;quoted&#39;</a></div>
<div class="result"><a class="result__a" href="https://b.example/two">Second</a>
<span class="result__snippet"></span></div>
<div class="result"><a class="result__a" href="https://a.example/one?x=1">Dup</a></div>
<a class="result__a" href="javascript:void(0)">junk</a>
</body></html>`;
const LITE_PAGE = `<html><body><table>
<tr><td><a class="result-link" href="https://c.example/three">Lite hit</a></td></tr>
<tr><td class="result-snippet">lite snippet</td></tr>
</table></body></html>`;

const server = createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => {
		chunks.push(chunk);
	});
	req.on("end", () => {
		seenRequests.push({
			url: req.url,
			body: Buffer.concat(chunks).toString()
		});
		if (req.url.startsWith("/html")) {
			if (req.url.includes("mode=fail")) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			res.writeHead(200, { "content-type": "text/html" });
			res.end(HTML_PAGE);
			return;
		}
		if (req.url.startsWith("/lite")) {
			if (req.url.includes("mode=fail")) {
				res.writeHead(403);
				res.end("forbidden");
				return;
			}
			if (req.url.includes("mode=slow")) {
				setTimeout(() => {
					res.writeHead(200);
					res.end(LITE_PAGE);
				}, 5000).unref();
				return;
			}
			res.writeHead(200, { "content-type": "text/html" });
			res.end(LITE_PAGE);
			return;
		}
		res.writeHead(404);
		res.end();
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
/** Full provider options against the local stand-in (test helper). */
const opts = (overrides = {}) => ({
	endpoint: "auto",
	language: "",
	safesearch: 1,
	timeRange: "",
	maxResults: 20,
	requestTimeoutMs: 15000,
	userAgent: "smoke",
	acceptLanguage: "en",
	htmlEndpointURL: `${base}/html`,
	liteEndpointURL: `${base}/lite`,
	...overrides
});
const provider = new mod.DuckDuckGoSearchProvider(() => opts());

// Auto mode: html succeeds first with parsed, deduped sources.
{
	const result = await provider.search({ query: "cat" });
	assert.deepEqual(result.sources.map((source) => source.url), ["https://a.example/one?x=1", "https://b.example/two"]);
	assert.equal(result.sources[0].title, "Cat & Dog guide");
	assert.equal(result.sources[0].snippet, "snippy first & 'quoted'");
	assert.equal(result.sources[1].title, "Second");
	assert.equal(result.truncated, false);
	const htmlCall = seenRequests.filter((entry) => entry.url.startsWith("/html")).at(-1);
	assert.equal(new URLSearchParams(htmlCall.body).get("q"), "cat", "html endpoint receives form-encoded query");
}

// The request's own bound caps the source list.
assert.equal((await provider.search({ query: "cat", maxResults: 1 })).sources.length, 1);

// Query options ride the wire (html endpoint carries them in the POST body).
await new mod.DuckDuckGoSearchProvider(() => opts({
	language: "ru-ru",
	safesearch: 0,
	timeRange: "month"
})).search({ query: "привет" });
const optionedBody = new URLSearchParams(seenRequests.filter((entry) => entry.url.startsWith("/html")).at(-1).body);
assert.equal(optionedBody.get("q"), "привет");
assert.equal(optionedBody.get("kl"), "ru-ru");
assert.equal(optionedBody.get("kp"), "-2", "safesearch 0 maps to the off wire value");
assert.equal(optionedBody.get("df"), "m");

// Html throttled → auto falls through to lite and still answers.
{
	const result = await new mod.DuckDuckGoSearchProvider(() => opts({
		htmlEndpointURL: `${base}/html?mode=fail`
	})).search({ query: "cat" });
	assert.deepEqual(result.sources.map((source) => source.url), ["https://c.example/three"]);
	assert.equal(result.sources[0].snippet, "lite snippet");
}

// Both endpoints failing → last HTTP error surfaces.
await assert.rejects(
	new mod.DuckDuckGoSearchProvider(() => opts({
		htmlEndpointURL: `${base}/html?mode=fail`,
		liteEndpointURL: `${base}/lite?mode=fail`
	})).search({ query: "cat" }),
	(error) => error.code === "WEB_PROVIDER_ERROR" && error.message.includes("HTTP 403")
);

// Single endpoint mode reports without falling through.
await assert.rejects(
	new mod.DuckDuckGoSearchProvider(() => opts({
		endpoint: "lite",
		liteEndpointURL: `${base}/lite?mode=fail`
	})).search({ query: "cat" }),
	(error) => error.code === "WEB_PROVIDER_ERROR"
);

// Caller cancellation wins even against a slow endpoint.
const controller = new AbortController();
const slow = new mod.DuckDuckGoSearchProvider(() => opts({
	endpoint: "lite",
	htmlEndpointURL: `${base}/html?mode=fail`,
	liteEndpointURL: `${base}/lite?mode=slow`
}));
const aborted = slow.search({ query: "cat" }, controller.signal);
controller.abort();
await assert.rejects(aborted, (error) => error.code === "WEB_ABORTED");

server.close();
console.log("SMOKE OK");
