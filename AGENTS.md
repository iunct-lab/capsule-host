# capsule-host

このリポジトリの固有の値（テスト、作業の場所、live check、マージ判定など）は `CLAUDE.md` にある。Codex もそれを読む。

- 公開リポジトリ: `iunct-lab/capsule-host`（Public。main のツリーだけを `ops-kit public-sync` で送る新しい履歴。Issue は要望だけで、Private の要望 Issue にしてから扱う。PR は受け付けない（自動で閉じる））
- 公開リポジトリへの同期: `ops-kit public-sync`（共通キットの `bin/ops-kit`。`--dry-run` は送らずに結果だけ出す）。公開先・外すファイル・書き換えるファイルは root の `ops.config.json` の `publicSync`。仕組みはキットの README の「公開リポジトリへの同期」、このリポジトリの手順は `docs/development-and-release.md`。`publicSync.exclude` のファイル（配置の記録 `docs/releases.md`、Actions の代わりの `scripts/local-ci.ts`）は Private だけにあり、公開のツリーには無い
