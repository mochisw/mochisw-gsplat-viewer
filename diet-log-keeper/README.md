# Diet Log Keeper

体重・体脂肪率の記録ツール。Google Sheets を正本とし、スマホ用フォームで入力、
前回比と直近7件平均を自動計算し、全期間グラフを表示する。

最小構成で満たすもの:

1. スマホで入力できる（GAS Web アプリのフォーム）
2. Google Sheets に保存できる
3. 前回比が分かる
4. 直近7件平均が分かる（7日平均ではなく直近7**件**の観測値平均）
5. 月末に全期間グラフを作れる（`?page=chart`）

```
diet-log-keeper/
├── README.md                  … このファイル（設計・セットアップ・運用手順）
├── claude-project-prompt.md   … Claude Project に設定する運用プロンプト
└── gas/
    ├── appsscript.json        … GAS マニフェスト（Asia/Tokyo, Webアプリ設定）
    ├── Code.gs                … 保存・計算・データ提供
    ├── Form.html              … スマホ入力フォーム
    └── Chart.html             … 全期間グラフ（Weight / Body Fat）
```

---

## 1. Google Sheets の列設計

シート名 `log`、1行 = 1計測。列は以下の11列（A〜K）。

| 列 | 名前 | 型 | 入力元 | 説明 |
|---|---|---|---|---|
| A | `date` | 文字列 `YYYY-MM-DD` | フォーム | 計測日。初期値は今日 |
| B | `timing` | 文字列 | フォーム | morning / before dinner / after dinner / after bath / before sleep / unknown |
| C | `weight_kg` | 数値 | フォーム | 体重 (kg) |
| D | `body_fat_percent` | 数値 | フォーム | 体脂肪率 (%) |
| E | `condition` | 文字列（カンマ区切り） | フォーム | normal / tired / poor sleep / travel / outing / drinking / ate out / exercise / sick / stressed の複数選択 |
| F | `note` | 文字列 | フォーム | 自由記述 |
| G | `created_at` | 文字列 `YYYY-MM-DD HH:mm:ss` | 自動 | 保存時刻（JST） |
| H | `weight_change_from_previous` | 数値 | 自動 | 前回レコードとの体重差。初回は空 |
| I | `body_fat_change_from_previous` | 数値 | 自動 | 前回レコードとの体脂肪率差。初回は空 |
| J | `weight_7_record_avg` | 数値 | 自動 | **直近7件**（当該行を含む）の体重平均。7件未満はある分だけで計算 |
| K | `body_fat_7_record_avg` | 数値 | 自動 | 直近7件の体脂肪率平均 |

設計上の決め事:

- H〜K は数式ではなく **保存時に GAS が値として書き込む**。行の並べ替えや削除で数式が壊れる事故を避けるため。
- 手動で行を修正・追記・削除した場合は `recalcAll()` を実行すると、date + created_at 順に並べ直して H〜K を全行再計算する。
- `date` と `created_at` は文字列列（表示形式 `@`）。タイムゾーンや自動日付変換の事故を避ける。

## 2. 初期シート構成

- シートは `log` の1枚だけ。集計・グラフ用の別シートは作らない（グラフは Web ページ側で描画）。
- 1行目: ヘッダー（太字・固定行）。
- 作成は手動ではなく、後述のセットアップで `setupSheet()` を1回実行する。

## 3. スマホ入力フォームの実装方式

**採用: Google Apps Script の Web アプリ**（`Form.html`）。

- 1画面・縦1カラム。date（初期値=今日）、timing（チップ型ラジオ）、weight / body fat（数値キーボード `inputmode=decimal`）、condition（チップ型の複数選択）、note。
- 保存後、その場に **日付・体重・体脂肪率・前回比・7件平均・短い見立て（日本語）・記録用1行** を表示する。記録用1行はコピー・ボタン付き:

  ```
  YYYY-MM-DD  65.2kg  14.4%
  ```

- iPhone のホーム画面に Web アプリ URL を追加すれば、アプリ感覚で開ける。

代替案（GAS Web アプリが使えない場合）:

| 案 | 内容 | 割り切り |
|---|---|---|
| Google Forms + Sheets | フォーム項目を同じ構成で作り回答先を `log` 相当のシートに | 前回比・7件平均は `recalcAll()` 相当を onFormSubmit トリガーで実行。送信直後の分析表示はできない |
| Claude Artifact フォーム + CSV | Artifact 上で入力し CSV 行を出力、Sheets に貼り付け | 保存が手動になる。正本が Sheets である点は維持 |

いずれの場合も正本は Google Sheets のまま。

## 4〜6. GAS コード / 保存処理 / 計算処理

`gas/Code.gs` に実装済み。要点:

- `doGet(e)` … 通常はフォーム、`?page=chart` でグラフページを返す。
- `saveLog(input)` … バリデーション → `LockService` で排他 → 直近6件を読み、
  **前回比**（直前レコードとの差）と **直近7件平均**（今回分を含む、7件未満はある分で平均）を計算して1行追記。
  分析結果（前回比・7件平均・見立て・記録用1行）を返す。
- `buildComment_()` … 短い見立て（日本語）。断定せず、単日変動は水分・食事・胃腸内容物等の影響込みで解釈。
  condition に tired / poor sleep / sick / stressed があれば労いを先に出す。
  after dinner / after bath 計測は重く出やすい旨を添える。深い分析は Claude Project 側に委ねる。
- `getChartData()` … グラフページ用に全レコードを返す。
- `recalcAll()` … 手動編集後のメンテ用。並べ直し + H〜K 再計算。
- `setupSheet()` … 初期シート作成（1回だけ実行）。

## 7. 月末グラフ

グラフ用シートは作らず、`Webアプリ URL + ?page=chart` を開くと全期間グラフ2枚を描画する
（外部ライブラリなしの SVG。iPhone 幅・ダークモード対応）。

| | Weight Trend | Body Fat Trend |
|---|---|---|
| Actual | blue | teal/green |
| 7-record average | orange | magenta/pink |

- 表記はすべて英語。各グラフ上部に PERIOD / START / LATEST / CHANGE を表示。
- 注釈は Latest / High / Low の3点のみ（詰め込まない）。
- タップ/ホバーで日付・実測・7件平均のツールチップ。

月末の手順: グラフページを開く → スクリーンショット → 必要なら Claude Project に貼って講評をもらう。
（自動化したければ月末トリガーでリマインドを送る拡張が可能だが、最小構成には含めない。）

## セットアップ手順（初回のみ、10分程度）

1. Google Drive で新規スプレッドシートを作成（名前は例: `Diet Log`）。
2. メニュー「拡張機能 → Apps Script」を開く。
3. ファイルを作成して中身をコピーする:
   - `Code.gs` ← `gas/Code.gs`
   - `Form.html` ← `gas/Form.html`（「HTML」ファイルとして追加）
   - `Chart.html` ← `gas/Chart.html`（同上）
   - プロジェクト設定 →「appsscript.json をエディタで表示」を有効化 → `gas/appsscript.json` の内容に置き換え
4. エディタで関数 `setupSheet` を選んで実行（初回は権限承認あり）→ `log` シートができる。
5. 「デプロイ → 新しいデプロイ → 種類: ウェブアプリ」
   - 実行ユーザー: **自分**
   - アクセスできるユーザー: **自分のみ**
6. 発行された URL を iPhone の Safari で開き、共有メニュー →「ホーム画面に追加」。
7. グラフは同じ URL に `?page=chart` を付けてブックマーク。

コードを更新したときは「デプロイ → デプロイを管理 → 編集 → 新しいバージョン」で反映する。

## 8. 運用手順

日次:

1. ホーム画面のアイコンからフォームを開く（毎回同じタイミング推奨。基本は morning）。
2. 体重・体脂肪率を入力して「記録する」。
3. 表示された前回比・7件平均・見立てを確認。気になる日は記録用1行をコピーして Claude Project に貼る。

月末:

1. `?page=chart` を開いて Weight Trend / Body Fat Trend を確認・スクリーンショット。
2. Claude Project に貼って月次の講評をもらう（分析コメントは日本語）。

メンテナンス:

- 過去分の修正・追記・削除をシート上で直接行ったら、Apps Script エディタで `recalcAll()` を実行。
- データのバックアップは Sheets 標準の「変更履歴」で足りる。

## 9. Claude Project 用プロンプト

`claude-project-prompt.md` をそのまま Claude Project の指示欄に貼る。
解釈ルール（食後は重く出る、単日変動を断定しない、事実と推察を分ける、疲れている日は労いが先、等）はそちらに集約してある。

---

## 今後の拡張候補（最小構成には含めない）

- 月末トリガー（`ScriptApp.newTrigger`）でグラフページのリンクをメール通知
- 月別サマリーシート（月平均・月内変化）
- CSV エクスポート関数
- 目標値ラインのグラフ重畳
