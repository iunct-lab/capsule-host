<!-- タイトルは Conventional Commits 風に: feat:/fix:/test:/docs:/chore: など -->

## 概要 / Summary

<!-- 1 PR = 1 Task。`Closes #<Task番号>` を書く（PBI を直接 Closes しない）。Task の Issue に結果コメントを残す（.claude/skills/issue-workflow） -->

<!-- 何を、なぜ変えたか。関連Issueがあれば `Closes #123` -->

## 影響コンポーネント / Affected components

- [ ] src/ 共通API・認可（cloud-host / host — 両方を揃える）
- [ ] src/client.ts（画面・導線）
- [ ] src/schema.ts・template・export（保存形式の互換性に注意）
- [ ] aws/（IaC・Lambda入口・CLI — 変更セットで置換/削除を確認）
- [ ] docs/
- [ ] docs / infra (.github, scripts)

## テスト観点 / Testing

- [ ] CI（`bun run check` と `sam validate --lint`）が green
- [ ] 認可・保存・削除を変えたら dev に配置して `bun aws/verify.ts` を通した
- [ ] 画面を変えたら実ブラウザ（スマホ幅）で確認した。やった事実だけ書く

## チェックリスト / Checklist

- [ ] 秘密（リンクの secret・Cookie・HMAC鍵）をログ・レスポンス・リポジトリに出していない
- [ ] 実旅程・実名・AWSアカウント固有値をコミットしていない
- [ ] cloud-host.ts と host.ts の認可ロジックが同じ挙動になっている
- [ ] 既存カプセルの読取互換性（schemaVersion・保存形式）を壊していない
- [ ] docs（README, aws/README, docs/）を必要に応じ更新した
