# Privacy

Repo Translator has no server, no analytics and no telemetry. The author never receives your data.

**What leaves your browser.** When you translate (by clicking, or automatically if you turned auto-translate on),
the text of the sections being translated is sent to `https://api.anthropic.com` using your own API key.
That is the About blurb, commit messages, README, issue or pull request text on the page you are viewing.
Nothing else is sent, and nothing is sent until you ask (unless auto-translate is on).
Anthropic's handling of API data is covered by Anthropic's own terms and privacy policy.

**What is stored on your device.** Your API key, your settings, and a cache of translations
(`storage.local`, not synced, capped at 5,000 entries). "Clear cache" in the options page removes the cache,
and "Remove key" removes the key.

**Permissions.** `storage` for the items above. Host access to `github.com` (to read and rewrite the page)
and `api.anthropic.com` (to translate). No other site is contacted.
