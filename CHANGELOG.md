# Changelog

## 1.2.1
- Fix the language label: a page in one language that links to other languages (for example a Chinese README with a "한국어" link) was labeled by the first foreign script found. It now picks the script with the most characters.
- Add a regression test for language detection.

## 1.2.0
- Translate the About blurb and commit messages as well as README, issue and PR text.
- Lazy translation: text is translated as it scrolls into view.
- Page-wide de-duplication of identical segments.
- Structured retry: malformed or wrong-length model answers split the batch and retry.
- Firefox build (desktop 140+, Android 142+) from the same source as Chrome.

## 1.0.0
- Initial release: translate a GitHub page to English with Claude Haiku, with code and links left untouched and a "Show original" toggle.
