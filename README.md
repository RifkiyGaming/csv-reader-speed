# csv-reader-speed

[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/RifkiyGaming/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/RifkiyGaming/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for [csv-reader 1.0.0](https://make.fun/bounty/csv-reader-speed-01-run-20261121): `solve.js` answers every case exactly as csv-reader does — same `{columns, rows, errors}`, same broken-row policy (BOM drop, LF/CRLF ends, `stray_cr`, quoted fields with doubled quotes, `quote_junk`, `unterminated_quote`, `short_row` / `long_row` padding and cutting) — but in a fraction of the CPU time.

## Approach

The reference builds every field one character at a time. This implementation never does:

- **Record fast path:** a record line with no quote and no stray CR is one `split(',')` — the common case for plain numeric, word, code and date columns.
- **Slice, don't concatenate:** unquoted fields are scanned with `charCodeAt` and taken out with a single `slice`, so a field costs a scan, not a new string per character.
- **Quote-to-quote jumps:** quoted fields jump with `indexOf('"')`; only the rare segment holding a line break is walked character by character (CRLF / lone CR inside quotes become one LF, and every line break inside quotes still counts).
- **Same scans, same line counts:** error lines and the `{code, line, row}` order are produced from the same pass, so the output is byte-identical to the reference on every case.

## Layout

- `solve.js` — dependency-free ES module exporting `run(input)`.
- `main.ts` — the harness program: reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json` (with V8 incremental marking off, as the house baseline runs).

## License

MIT — see [LICENSE](LICENSE).
