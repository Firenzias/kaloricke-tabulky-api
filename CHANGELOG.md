# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). See "Versioning" in the readme for what counts as the
public API.

## [1.2.0] - 2026-11-23

### Added
- `getWeight(from, to)` for `/statistic/weight/{from}/{to}/get?format=json`. `'weight'` is a new `KtStatisticKind`
  and the response type `KtWeightResponse` (with `ktWeightResponseSchema` and `ktWeightPoints`) is exported.
- `flattenKtSeriesValues()`: accepts both flat series entries and wrapped `{ value, target }` entries, drops entries
  that do not match, and removes duplicates by `guid` (or `from` when there is none).

### Changed
- `KtSeries.values` is now kept raw (`unknown[]`) so the archived payload stays lossless. Call
  `flattenKtSeriesValues(series.values ?? [])` to get typed points. Code that read `values[i].value` directly must
  go through that function.

## [1.1.0] and earlier

Not tracked in this file; see the git history.

[1.2.0]: https://github.com/Firenzias/kaloricke-tabulky-api/compare/ad0ccb6...v1.2.0
