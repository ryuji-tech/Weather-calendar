# Weather Calendar 🌤️

現在の天気にあわせて、背景がリアルタイムに変化するカレンダー。
都市を検索すると [Open-Meteo](https://open-meteo.com/) から現在の天気を取得し、
[three.js](https://threejs.org/) + GLSL シェーダーで空・雲・雨・雪・雷を描画します。

> A calendar whose background reacts to the live weather of any city — built with the Open-Meteo API and three.js / GLSL shaders.

**▶ ライブデモ：https://ryuji-tech.github.io/Weather-calendar/**

![天気の切り替え（晴れ・曇り・霧・雨・雷雨・雪）](docs/demo.gif)

---

## ✨ 特徴

- **天気でリアルタイムに変わる背景** — 快晴・晴れ時々曇り・曇り・霧・雨・雷雨・雪の7パターンを、GLSL シェーダー（空のグラデ・流れる雲・太陽グロー）と `THREE.Points` パーティクル（雨・雪）で表現。
- **天気間のなめらかな遷移** — 色・雲量・降水量などをフレーム補間し、天気の切り替えがスッと馴染む。
- **実 API 連携** — Open-Meteo の Geocoding API（都市名→緯度経度）と Forecast API（現在の天気）をキー不要で利用。
- **アクセシビリティ配慮** — OS の「視差効果を減らす（prefers-reduced-motion）」設定時は three.js を起動せず、静的なグラデーション背景にフォールバック。
- **依存ライブラリは three.js のみ**。ビルド不要、ファイルを開けば動く静的構成。

## 🛠 使用技術

| 領域 | 内容 |
|---|---|
| 背景描画 | three.js (r128) + GLSL フラグメントシェーダー、`THREE.Points` パーティクル |
| 天気データ | Open-Meteo Forecast API（`current` / WMO weather code） |
| 地名検索 | Open-Meteo Geocoding API |
| フロント | Vanilla JS / HTML / CSS（フレームワークなし） |
| 永続化 | localStorage（メモ） |

## 📋 機能

- 月表示カレンダー（前月・次月・今日への移動）
- 日付マスへのインラインメモ（localStorage に保存）
- 都市検索 → 現在の天気を取得して背景・気温・体感・湿度・風速を表示
- 天気プレビュー（7天気をボタンで手動切替）

## 🔍 工夫した点

- **WMO 天気コードのグルーピング** — Open-Meteo が返す 0〜99 のコードを 7 つの表現パターンにマッピング。
- **パーティクルの使い回し** — 雨・雪の粒子は画面外に出たら上部へ循環させ、生成・破棄を避けて軽量化。
- **描画負荷への配慮** — `devicePixelRatio` を上限 2 に丸めて高 DPI 環境の負荷を抑制。reduced-motion フォールバックは負荷ゼロの保険も兼ねる。
- **可読性優先のレイアウト** — 白いカレンダー面は固定し、天気演出は背景にのみ効かせて情報の読みやすさを担保。

## 🚀 ローカルで動かす

クローンして `index.html` をブラウザで開くだけです（ビルド不要）。

```bash
git clone https://github.com/ryuji-tech/weather-calendar.git
cd weather-calendar
open index.html   # もしくはブラウザにドラッグ＆ドロップ
```

天気取得・地名検索はオンライン接続が必要です（オフライン時はプレビュー表示にフォールバック）。

## 📄 クレジット

- 天気・地名データ：[Open-Meteo.com](https://open-meteo.com/) — ライセンス **CC BY 4.0**
- 3D 描画：[three.js](https://threejs.org/)

## 📝 ライセンス

本リポジトリのコードは [MIT License](LICENSE) で公開しています。
（天気データの利用は Open-Meteo の CC BY 4.0 に従います）

---

※ 本プロジェクトは API 連携の学習用ポートフォリオとして制作したものです。
