# Security

## Design
- The API key is read only by the background script, sent only to `api.anthropic.com`, never returned to content scripts and never logged.
- The background script rejects messages from other extensions.
- Page text is treated as untrusted. Model output is placed back into the page as text, never parsed as HTML.

## Reporting a vulnerability
Please open a private report through the repository's Security tab ("Report a vulnerability"), or contact the maintainer
through the email on the GitHub profile. Please do not file a public issue for a vulnerability.
