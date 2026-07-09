# Created by @tylahfam97 

Hello!

## Compass 0.4.31 - Security & Trust Fixes

### Auto-Update on Launch
- Compass now silently checks for updates 2.5 seconds after startup
- If a newer version is available, a modal prompt appears with the version number and release notes
- **Install now** downloads and installs immediately; **Later** dismisses the modal with no further interruption
- Manual "Check for updates" in the sidebar is unchanged and still works as before

### Encryption Documentation Corrected
- The Security & Privacy FAQ in the README previously stated the database was not encrypted — this was incorrect
- The database has always been encrypted at rest using **SQLCipher (AES-256)** since the encrypted backend was introduced
- The encryption key is a 32-byte random value stored in **Windows Credential Manager** (DPAPI-backed), bound to your Windows user account
- A fallback copy is written to `compass.key` in the app data folder in case Credential Manager loses the entry
- README now accurately documents both data files (`com.compass.app.db` and `compass.key`), what each contains, and that both must be copied together for a complete portable backup
