# End-to-end tests on the live demo (2026-10-30 16:05 KST)

Each row is one real request to https://seoulmate-dje.pages.dev/api/chat (Qloo Hackathon API + Gemini).
Baseline = the general top 200 for the same category in the request city (US if none). Matches already in it are removed as popular with everyone; the rest are shown as hidden pulls.

| Case | Input | HTTP | Time (s) | Outcome | Qloo/tool calls | Tool errors | Categories with results | Categories | Baseline comparison | Neighbour places | First item per category |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Deli (food) | {"business": "Russ & Daughters", "city": "New York"} | 200 | 39 | playbook | 7 | 0 | 4 | music, film, brands, books | baseline ok 4/4 cats; removed as locally popular: 25 (e.g. Ramona Lisa #128, Sorry to Bother You #17, The Infatuation #9) | 10 | music: Ariel Pink; film: Don't Think Twice; brands: Oddfellows |
| Cafe (UK) | {"business": "Monmouth Coffee", "city": "London"} | 200 | 39 | playbook | 7 | 0 | 4 | music, film, brands, books | baseline ok 4/4 cats; removed as locally popular: 22 (e.g. Skepta #51, The Hoxton #13) | 10 | music: Manga Saint Hilare; film: Silver Haze; brands: Onefinestay |
| Beauty brand (no city) | {"business": "Glossier"} | 200 | 32 | playbook | 6 | 0 | 4 | music, film, brands, books | baseline ok 4/4 cats; removed as locally popular: 7 (e.g. SZA #19, Reformation #39) | 0 | music: Clairo; film: Booksmart; brands: Flesh |
| Unknown tiny shop | {"business": "Mi-ra's Kimchi Corner", "city": "Gimpo"} | 422 | 31 | refused | 3 | 0 | 0 |  | baseline ok 0/0 cats; removed as locally popular: 0 (e.g. ) | 0 |  |
| Random string | {"business": "xqzv blorp 123"} | 422 | 24 | refused | 2 | 0 | 0 |  | baseline ok 0/0 cats; removed as locally popular: 0 (e.g. ) | 0 |  |

Expected: the three known businesses produce a playbook from ≥4 measured categories; the unknown shop and the random string are refused (HTTP 422) instead of guessed.
