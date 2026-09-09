<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="96" alt="Compass app icon" />
</p>

# Compass

**Personal finance, kept on your computer.**

Import your statements, understand your spending, and plan ahead. Compass is a free, open-source desktop app with no bank login, subscription, or cloud account required.

[Download](https://github.com/tylahfam97/Compass/releases/latest) · [Website](https://privatecompass.app) · [Release notes](RELEASE_NOTES.md) · [Report an issue](https://github.com/tylahfam97/Compass/issues)

## Get Started

1. Install Compass from the [latest release](https://github.com/tylahfam97/Compass/releases/latest).
2. Try **Demo Mode** to explore with sample data, or create a profile for your own finances.
3. Export transactions from your bank, open **Import**, and review the detected columns and preview.
4. Check your categories, set a budget or goal, and add upcoming bills and income in **Plan**.

Compass works offline after installation. No bank connection is needed; import another statement whenever you want to bring your data up to date.

### Platforms

| Platform | Download | Requirements |
|---|---|---|
| Windows | `.exe` installer or `.msi` package | Windows 10/11, 64-bit; WebView2 is installed if missing |
| macOS (beta) | Universal `.dmg` | macOS 10.15+; Intel or Apple Silicon |

Check the release notes for signing status and platform-specific installation instructions. Unsigned macOS builds may require approval in **System Settings > Privacy & Security** after the first launch attempt. Only approve a download you trust from the official release page.

## What You Can Do

| Workspace | Purpose |
|---|---|
| **Dashboard** | Review the selected month's income, expenses, savings, and recent activity. |
| **Transactions** | Search, filter, sort, edit, and categorize transactions; make bulk changes or export the filtered view as CSV. |
| **Trends & Reports** | Compare periods, examine category and merchant spending, and review recurring charges. |
| **Budgets & Goals** | Set weekly or monthly limits, enable monthly rollover, and track savings, spending, balance, and debt targets. |
| **Insights** | Start with expanded, full-width financial context and scores, followed by Action Items, Observations, and Wins. |
| **Plan** | Forecast checking cash flow, review upcoming bills and income, and explore what-if spending and cushion adjustments. |
| **Investments** | Track dated portfolio snapshots, allocation, holdings, statement activity, and income and gains. |
| **All Accounts** | Review balances across profiles, with an option to include investments. |

The desktop workspace supports light and dark themes, keyboard navigation, and reduced motion. Profiles keep financial histories separate; supported **Global** views combine unlocked profiles.

### Statement Import

- **Bank and credit card transactions:** CSV and spreadsheet imports with guided column mapping, previews, saved layouts, and duplicate detection. Batch import handles multiple files.
- **Automatic categorization:** Built-in rules plus editable custom rules, including optional amount conditions and advanced matching.
- **Investments:** Supported exports include Wells Fargo Advisors, Fidelity, and Thrivent; supported PDF statements include Principal 401(k) and E*TRADE / Morgan Stanley. Format support varies by institution and statement type.
- **Loans:** Import supported loan statements or manage account details such as interest rate and minimum payment.

Review imported balances and categories against your statement. Transfers and the **Excluded** category do not count toward income or expenses; credit card payments are treated as transfers to avoid counting them twice.

### Financial Context and Planning

Insights brings financial context and health scores to the top of the page, with review items underneath. Scores and patterns are calculated locally from your available data, not by a cloud AI service. Limited history is identified rather than treated as a complete assessment.

Plan projects spendable checking cash over the rest of the month, to your next paycheck, or for the next 30 days. It combines scheduled bills and income, detected recurring charges, and historical spending to estimate **safe to spend** and your **projected lowest balance**. A forecast requires at least two months of history.

Debt payoff tools compare **Avalanche**, **Snowball**, and **Cash-flow First** strategies and let you explore redirecting spending toward repayment. These are estimates, not promises or financial advice.

## Privacy and Data Safety

Your financial records stay local. Compass has no telemetry, analytics, or cloud sync. Update checks and downloads contact GitHub; they do not upload your financial records. Installing an update requires your confirmation.

### Storage and Encryption

Compass uses an encrypted SQLite database through **SQLCipher (AES-256)**. The Rust backend retrieves the encryption key from Windows Credential Manager or macOS Keychain, with a fallback key file in the app data directory.

| Platform | App data directory |
|---|---|
| Windows | `%APPDATA%\com.compass.app\` |
| macOS | `~/Library/Application Support/com.compass.app/` |

The directory contains `compass.db` and `compass.key`. **The key file can unlock the database: protect both files and any backups.** Database encryption is not a substitute for securing your OS account and device.

### Backup, Export, and Restore

- **Full backup:** Use **Settings > Backup & Restore > Export Backup** to create a `.compassbackup` file. It includes the database and its encryption key, so treat it as sensitive financial data and store it securely.
- **Restore:** Use **Restore Backup** in Settings. Compass validates the backup and relaunches to complete restoration.
- **CSV export:** In Transactions, select **All time**, clear filters, and export. Repeat for each profile. CSV exports are plaintext and do not include all app settings or account data.
- **Manual backup:** Close Compass before copying both `compass.db` and `compass.key`. The database alone is not a portable backup without its matching key.

**Settings > Erase this profile's data** permanently removes the active profile's financial data after typed confirmation, without erasing other profiles. Back up first. Uninstalling is not a data-erasure method; remove the app data directory separately if you intend to delete the local files.

## Current Limits

- Desktop only: Windows and macOS beta; no mobile app or supported Linux release.
- No live bank connections, cloud sync, or collaborative access.
- Single-currency tracking; no multi-currency conversion.
- Bank transaction imports do not support OFX/QIF or arbitrary statement PDFs.
- Scheduled bills and income feed the forecast but never create real transactions automatically.
- Cash-flow forecasts cover checking/debit accounts, not projected credit card balances.
- Results depend on statement coverage, correct categories, and up-to-date balances. Always verify important figures with your financial institution.

## Development

Built with **Tauri 2, React 19, TypeScript, Rust, and SQLite**, using Vite, Tailwind CSS, Zustand, and Recharts.

### Prerequisites

- [Node.js 24+](https://nodejs.org/) and npm.
- [Rust](https://rustup.rs/) with the stable toolchain.
- [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), including C++ Build Tools and WebView2 on Windows, or Xcode Command Line Tools on macOS.

```sh
git clone https://github.com/tylahfam97/Compass.git
cd Compass
npm ci
npm run tauri dev
```

Use the Tauri command for the working desktop app. `npm run dev` starts only the Vite frontend; native database and OS integrations require Tauri.

### Build and Test

```sh
# Type-check and build the frontend
npm run build

# Unit tests
npm test

# Install the browser once, then run end-to-end tests
npx playwright install chromium
npm run test:e2e

# Build the desktop application and installers
npm run tauri build
```

Desktop bundles are written to `src-tauri/target/release/bundle/`. Distribution signing and release publishing require additional credentials and release configuration.

### Repository Layout

| Directory | Contents |
|---|---|
| `src/` | React pages, components, stores, and financial logic |
| `src-tauri/` | Rust backend, native integrations, and desktop packaging |
| `tests/` | Playwright end-to-end tests |
| `sample-data/` | Import format fixtures |
| `scripts/` | Build, signing, and release utilities |
| `website/` | Public website |

## Contributing and Support

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). For bugs or feature requests, [open an issue](https://github.com/tylahfam97/Compass/issues) with your Compass version, OS, steps to reproduce, and expected behavior.

For import issues, include the institution name, file type, and the step that failed. A header row and a few rows of **invented data** are usually enough to demonstrate a format problem. Never attach real statements, account numbers, databases, encryption keys, or backups.

Release history lives in [RELEASE_NOTES.md](RELEASE_NOTES.md).

## License

[MIT](LICENSE.txt). Compass is provided as-is and is not financial advice.