<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="88" alt="Compass app icon" />
</p>

<h1 align="center">Compass</h1>

<p align="center"><b>Spending tracker for the CSV and Excel statements you download from your bank. No bank login.</b></p>

<p align="center">
  <a href="https://github.com/tylahfam97/Compass/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/tylahfam97/Compass?color=c08a1c&label=release"></a>
  <a href="https://github.com/tylahfam97/Compass/actions/workflows/playwright.yml"><img alt="End-to-end tests" src="https://github.com/tylahfam97/Compass/actions/workflows/playwright.yml/badge.svg"></a>
  <a href="LICENSE.txt"><img alt="MIT licence" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Windows and macOS" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey">
</p>

<p align="center">
  <a href="https://github.com/tylahfam97/Compass/releases/latest">Download</a> ·
  <a href="https://privatecompass.app">Website</a> ·
  <a href="https://privatecompass.app/import-guide.html">Import guide</a> ·
  <a href="RELEASE_NOTES.md">Release notes</a> ·
  <a href="https://github.com/tylahfam97/Compass/issues">Report an issue</a>
</p>

<p align="center">
  <img src="website/img/overview.webp" width="900" alt="Compass Overview: net worth drawn as depth above and below a zero waterline, with a projected date it clears zero, and a table of every account" />
</p>

Download a CSV or Excel statement from your bank or card issuer and import it. Then see where your money actually goes. Compass is a free, open-source desktop app for Windows, with a macOS beta. You don't hand over a bank login or pay a subscription, and there's nothing to sign up for. Your statements are read on your machine, and the transactions are stored there in an encrypted database ([how the encryption works, and what it doesn't cover](#your-data)).

## Why Compass

- **No bank login.** Compass imports statement files you download yourself. It never asks for a bank login and has no way to reach your accounts.
- **Encrypted and local.** Your data is stored in a SQLCipher (AES-256) database on your own disk. The key lives in your OS credential store, with a key file fallback that can decrypt the database, so [protect both](#your-data).
- **No telemetry.** No analytics, no cloud sync and no account. Compass checks GitHub for updates and doesn't upload your financial data.
- **Rules you can check.** Built-in category rules plus your own, with a live preview of what a rule matches before you save it.
- **Free and open source.** MIT licensed, so you can read exactly what it does with your money.

## What you get

| Workspace | What it answers |
|---|---|
| **Overview** | Where you stand across every account. Net worth is drawn as depth above and below a zero waterline, and when you are below it, the pace you have actually been climbing at projects the month you clear zero. |
| **Dashboard** | How this month is going: income, spending, what is still due, and how this pay cycle compares with your own usual pace. |
| **Chart** | Where a month's money went, drawn as currents from paychecks through accounts out to bills, categories, cards, savings and debt, with a day-by-day scrubber. |
| **Transactions** | Search, filter, edit and categorise; make bulk changes or export the filtered view as CSV. |
| **Trends & Reports** | Compare periods, and examine category, merchant and recurring spending. |
| **Budgets & Goals** | Weekly or monthly limits with optional rollover, and savings, spending, balance or debt targets. |
| **Plan** | Forecast spendable cash to your next paycheck, with safe-to-spend, projected lowest balance, and Avalanche, Snowball or Cash-flow First payoff comparisons. |
| **Insights** | Health scores, a fixed-versus-flexible view of an average month, what your money cost or earned in interest, and action items ordered by the money at stake. |
| **Investments** | Dated portfolio snapshots, allocation, holdings, and income and gains. |

Light and dark themes, keyboard navigation and reduced motion throughout. Profiles keep separate
financial histories, and Global views combine the ones you unlock.

<p align="center">
  <img src="website/img/dashboard-poster.webp" width="32%" alt="The Overview page with net worth above and below the waterline" />
  <img src="website/img/import-wizard-poster.webp" width="32%" alt="The import wizard's first screen, where you choose a bank, credit card or investment statement" />
  <img src="website/img/insights-poster.webp" width="32%" alt="The Insights page with health scores and spending analysis" />
</p>

<p align="center"><sub><a href="https://privatecompass.app#inaction">Watch these as full walkthroughs on the website</a></sub></p>

## Get started

1. Install from the [latest release](https://github.com/tylahfam97/Compass/releases/latest).
2. Try **Demo Mode** to explore with sample data, or create a profile for your own finances.
3. Download a CSV or Excel (.xlsx) statement from your bank or card issuer, open **Import**, and check the detected columns and amount signs in the preview. The [import guide](https://privatecompass.app/import-guide.html) walks through each step.
4. Review your categories and save rules for merchants you see often, then add upcoming bills and income in **Plan**.

Compass works offline after installation. Import another statement whenever you want to bring your
data up to date.

| Platform | Download | Requirements |
|---|---|---|
| Windows | `.exe` installer or `.msi` package | Windows 10/11 64-bit. WebView2 is installed if missing. |
| macOS (beta) | Universal `.dmg` | macOS 10.15+, Intel or Apple Silicon |

Windows builds are code-signed, and Windows will show the publisher as **Chrysis Networks**. If you
see any other publisher, you did not get the file from here.

macOS builds are not notarized yet, so the first launch needs approval in **System Settings >
Privacy & Security**. Only approve a download you trust from the official release page.

### What imports

- **Banks and credit cards:** CSV files and Excel (.xlsx) workbooks, with guided column mapping, a preview, saved layouts for repeat imports, and duplicate detection. One signed amount column, a Debit/Credit label column, and separate Debit and Credit columns are all supported. Batch import handles multiple files. Step by step: [import guide](https://privatecompass.app/import-guide.html).
- **Investments:** Wells Fargo Advisors, Fidelity and Thrivent exports; Principal 401(k) and
  E\*TRADE / Morgan Stanley PDF statements. Support varies by institution and statement type.
- **Loans:** supported loan statements, or enter the rate and minimum payment yourself.
- **Categorisation:** built-in rules plus your own, with a live preview showing what each rule
  matches before you save it.

Transfers and the **Excluded** category never count as income or expenses, and credit card payments
are treated as transfers so they are not counted twice.

## Your data

Compass stores an encrypted SQLite database through **SQLCipher (AES-256)**. The Rust backend keeps
the key in Windows Credential Manager or the macOS Keychain, with a key file in the app data
directory as a fallback.

| Platform | App data directory |
|---|---|
| Windows | `%APPDATA%\com.compass.app\` |
| macOS | `~/Library/Application Support/com.compass.app/` |

That directory holds `compass.db` and `compass.key`. **The key file unlocks the database, so protect
both files and any backup of them.** Encryption at rest is not a substitute for securing your device.

Compass does not create or convert a database until `compass.key` has been saved and read back; if
it cannot be saved, Compass stops with an error and creates nothing, so it never falls back to an
unencrypted database. An existing encrypted database is never re-keyed or replaced: with a missing or
wrong key Compass stops and leaves the files as they are. Before a different key in the credential
store or `compass.key` is replaced, it is kept as `compass.key.unmatched-<n>`. An unencrypted
`compass.db` from an earlier version is converted on launch; the original is kept until the encrypted
copy has been checked. If `compass.db` is missing while an earlier upgrade or restore left
`compass.db.bak`, `compass.enc.db`, `compass.db.pending` or `compass.db.beforerestore*` behind,
Compass stops instead of starting empty. Copies of the database made outside Compass (including old
backups) are not converted.

- **Full backup:** **Settings > Backup & Restore > Export Backup** writes a `.compassbackup` file.
  It contains the database and its key, so treat it as sensitive.
- **Restore:** **Restore Backup** validates the file and relaunches to finish.
- **CSV export:** in Transactions, select **All time**, clear filters and export. Repeat per profile.
- **Erase:** **Settings > Erase this profile's data** permanently removes one profile's data after a
  typed confirmation.

## Current limits

Worth knowing before you install:

- Windows and macOS (beta) only. There is no mobile app and no supported Linux release.
- No live bank connections, cloud sync or shared access.
- Single currency, with no conversion.
- Bank imports do not support OFX, QIF or arbitrary PDF statements.
- Scheduled bills and income feed forecasts but never create real transactions.
- Cash-flow forecasts cover checking and debit accounts, not projected credit card balances.
- Forecasts need at least two months of history, and every figure depends on the statements you
  have imported. Verify anything important against your bank.

Compass is not financial advice.

## Development

Built with **Tauri 2, React 19, TypeScript, Rust and SQLite**, using Vite, Tailwind CSS, Zustand and
Recharts. Financial logic lives in pure, unit-tested modules under `src/lib/`.

Requires [Node.js 24+](https://nodejs.org/), [Rust](https://rustup.rs/) stable, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```sh
git clone https://github.com/tylahfam97/Compass.git
cd Compass
npm ci
npm run tauri dev     # the real desktop app; `npm run dev` is frontend only
```

```sh
npm test              # unit tests
npm run build         # type-check and build the frontend
npx playwright install chromium && npm run test:e2e
npm run tauri build   # installers, written to src-tauri/target/release/bundle/
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
[Open an issue](https://github.com/tylahfam97/Compass/issues) with your Compass version, OS, steps to
reproduce and what you expected.

For import problems, include the institution, the file type and the step that failed. A header row
and a few rows of **invented data** are enough. Never attach real statements, account numbers,
databases, keys or backups.

## Support

I build and maintain Compass alone. Plenty of apps in this category run on a subscription; Compass is free because there is no cloud service behind it to fund, not because a paid tier is waiting, and I would rather it existed than be paid for building it.

Sending something is absolutely not expected, and nothing changes if nobody does. There is one build
and one source tree, so nothing below buys a version of Compass you do not already have.

| Where | Network | Destination |
|---|---|---|
| Buy Me a Coffee | | <https://buymeacoffee.com/tylahfam> |
| Bitcoin | Bitcoin network, native segwit | `bc1quygw2ja2cavvr47m4wq6mynxfxkp4gs8n02ez8` |
| Ethereum | Ethereum mainnet | `0x5d7fDB0ECfAee39cA263714895B9DD7A51Fb375f` |
| XRP | XRP Ledger, classic address | `rPapQaPmtLv6HX3YS34gnhVDYrsyfHgL5o` |

An address printed on a page is not something you can verify by looking at it. The same four are on
[privatecompass.app](https://privatecompass.app/#support), and every change to them here is a commit
with a date and my name on it. If a Compass address appears anywhere other than those two places, it
did not come from me.

Send each asset on the network named beside it and nothing else. Transfers cannot be undone and there
is no support desk on either end. If you have not done this before, send a small amount first.

Buy Me a Coffee is a payment processor, so they will know you paid. The app on your machine never
contacts them. Nothing recurs unless you choose it there, and you can stop it there.

## License

[MIT](LICENSE.txt).
