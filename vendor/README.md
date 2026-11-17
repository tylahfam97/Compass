`xlsx-0.20.3.tgz` is the official SheetJS 0.20.3 package (the spreadsheet reader behind Excel imports), downloaded from https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz and installed from here by `package.json`.
npm's `xlsx` package stopped at 0.18.5, so builds with the security fixes come from SheetJS directly; keeping the file in the repository means installs do not depend on that CDN.
SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` (the `package-lock.json` integrity pins the same bytes).
To verify: download the URL above and compare, e.g. `curl -sL <url> | sha256sum` and `sha256sum vendor/xlsx-0.20.3.tgz` must both print that value.
