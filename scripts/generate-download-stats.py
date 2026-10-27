#!/usr/bin/env python3
"""Compass download statistics generator.

Runs on the nginx self-hosted runner (see .github/workflows/download-stats.yml).
Gathers two independent sources:

  1. GitHub release asset download counts - the GitHub API already tracks
     `download_count` per asset per release. Installers (.exe/.msi/.dmg) and
     in-app update packages (.nsis.zip) are reported separately; signatures,
     latest.json and anything else are ignored.
  2. Website installer requests - parsed from Compass's own nginx access logs
     (compass.access.log, including rotated .N and .N.gz files).

Website hits on the stable symlink names (Compass.exe / .msi / .dmg) are
attributed to a version by comparing the request time against the mtimes of
the versioned files in the downloads dir - the Host Release Downloads workflow
writes Compass_<version>_... there (curl, so mtime = hosting time) and then
repoints the symlink, so "newest versioned file whose mtime is at/before the
request" is the version the symlink served.

Because logrotate only keeps ~14 days of nginx logs, per-day counts are merged
into a persistent state file so history accumulates across runs. A day seen
again replaces the stored day only if it is not smaller, so a partially
rotated-away day or an empty read never lowers recorded history. The last good
GitHub fetch is kept there too, so an API failure shows stale data, not zero.

What the numbers are NOT: HTTP requests are not completed installs or people.

Outputs:
  - <WEB_ROOT>/<STATS_DIR>/index.html   hidden, noindex stats page
  - <WEB_ROOT>/<STATS_DIR>/stats.json   same data, machine-readable
  - stdout                              Markdown summary (piped to the
                                        Actions step summary / email body)

Environment (all optional):
  REPO           owner/repo for the GitHub API        (default tylahfam97/Compass)
  GH_TOKEN       token for API rate limits            (recommended in CI)
  LOG_GLOB       Compass nginx access logs            (default /var/log/nginx/compass.access.log*)
  DOWNLOADS_DIR  hosted installers dir                (default /var/www/compass/downloads)
  WEB_ROOT       website document root                (default /var/www/compass/website)
  STATS_DIR      page directory name under WEB_ROOT   (default "stats")
  STATE_FILE     accumulated per-day counts           (default ~/.compass-download-stats-state.json)
"""

import glob
import gzip
import html
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = os.environ.get("REPO", "tylahfam97/Compass")
GH_TOKEN = os.environ.get("GH_TOKEN", "")
LOG_GLOB = os.environ.get("LOG_GLOB", "/var/log/nginx/compass.access.log*")
DOWNLOADS_DIR = Path(os.environ.get("DOWNLOADS_DIR", "/var/www/compass/downloads"))
WEB_ROOT = Path(os.environ.get("WEB_ROOT", "/var/www/compass/website"))
STATS_DIR = os.environ.get("STATS_DIR", "stats")
STATE_FILE = Path(os.environ.get("STATE_FILE", str(Path.home() / ".compass-download-stats-state.json")))

FAMILIES = ("exe", "msi", "dmg")
PER_PAGE = 100
VERSIONED_RE = re.compile(r"^Compass_(\d+\.\d+\.\d+)_.*\.(exe|msi|dmg)$", re.IGNORECASE)
# nginx "combined" format: ip - user [time] "METHOD path HTTP/x" status bytes "referer" "ua"
LOG_RE = re.compile(
    r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^" ]+)[^"]*" (\d{3}) (\S+) "[^"]*" "([^"]*)"'
)
TIME_RE = re.compile(r"^(\d{2})/(\w{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$")
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def semver_key(v: str):
    try:
        return tuple(int(p) for p in v.split("."))
    except ValueError:
        return (0,)


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ── 1. GitHub release download counts ────────────────────────────────────────

def asset_kind(name: str):
    n = name.lower()
    if n.endswith(".nsis.zip"):
        return "updater"   # what latest.json points the in-app updater at
    if n.endswith((".exe", ".msi", ".dmg")):
        return "installer"
    return None            # .sig, latest.json, checksums: not downloads of Compass


def fetch_github_releases():
    """Every page of releases; raises on any failure so nothing partial is published."""
    raw, page = [], 1
    while True:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{REPO}/releases?per_page={PER_PAGE}&page={page}",
            headers={"Accept": "application/vnd.github+json",
                     **({"Authorization": f"Bearer {GH_TOKEN}"} if GH_TOKEN else {})},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            batch = json.load(resp)
        if not isinstance(batch, list):
            raise ValueError(f"unexpected API response on page {page}")
        raw += batch
        if len(batch) < PER_PAGE:
            break
        page += 1
    out = []
    for r in raw:
        if r.get("draft"):
            continue
        kinds = {"installer": [], "updater": []}
        for a in r.get("assets", []):
            k = asset_kind(a["name"])
            if k:
                kinds[k].append({"name": a["name"], "count": a["download_count"]})
        out.append({
            "tag": r.get("tag_name", "?"),
            "prerelease": bool(r.get("prerelease")),
            "published": (r.get("published_at") or "")[:10],
            "assets": kinds["installer"],
            "total": sum(a["count"] for a in kinds["installer"]),
            "updater_assets": kinds["updater"],
            "updater": sum(a["count"] for a in kinds["updater"]),
        })
    return out


# ── 2. Website installer requests from nginx logs ────────────────────────────

def version_timeline():
    """Per family: [(hosted_at_utc, version)] sorted ascending, from file mtimes."""
    timeline = {f: [] for f in FAMILIES}
    if DOWNLOADS_DIR.is_dir():
        for p in DOWNLOADS_DIR.iterdir():
            m = VERSIONED_RE.match(p.name)
            if m and not p.is_symlink():
                when = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
                timeline[m.group(2).lower()].append((when, m.group(1)))
    for fam in timeline:
        timeline[fam].sort()
    return timeline


def attribute(timeline, fam: str, when: datetime) -> str:
    version = None
    for hosted_at, v in timeline.get(fam, []):
        if hosted_at <= when:
            version = v
        else:
            break
    return version or "unknown"


def parse_time(s: str):
    """10/Sep/2026:13:55:36 +0000 -> aware datetime in the log's own offset (None if malformed)."""
    m = TIME_RE.match(s)
    if not m or m.group(2) not in MONTHS:
        return None
    d, mon, y, hh, mm, ss, sign, oh, om = m.groups()
    off = timedelta(hours=int(oh), minutes=int(om)) * (1 if sign == "+" else -1)
    return datetime(int(y), MONTHS[mon], int(d), int(hh), int(mm), int(ss),
                    tzinfo=timezone(off))


def read_log_lines():
    files = sorted(glob.glob(LOG_GLOB))
    if not files:
        sys.exit(f"::error title=No Compass access logs::nothing matches {LOG_GLOB}")
    for f in files:
        opener = gzip.open if f.endswith(".gz") else open
        try:
            with opener(f, "rt", errors="replace") as fh:
                yield from fh
        except PermissionError:
            sys.exit(f"::error title=Runner cannot read {f}::One-time server setup needed. Run: "
                     "sudo usermod -aG adm <runner user>, then restart the runner service and re-run.")


def parse_website_downloads():
    """Days (the log's own calendar date, as stored since tracking began) in the current logs:
    counts      {day: {family: {version: n}}}  GET 200/206 on /downloads/ installers
    revalidated {day: n}                       GET 304 on the same paths (not downloads)
    coverage    [first, last] request time seen in the logs, or None
    """
    timeline = version_timeline()
    counts: dict = {}
    revalidated: dict = {}
    first = last = None
    partial_seen = set()  # (day, path, version, ip, ua) - download managers send many 206s per file
    for line in read_log_lines():
        m = LOG_RE.match(line)
        if not m:
            continue
        ip, raw_when, method, path, status, _bytes, ua = m.groups()
        when = parse_time(raw_when)
        if when is None:
            continue
        first = when if first is None or when < first else first
        last = when if last is None or when > last else last
        if method != "GET" or not path.startswith("/downloads/"):
            continue  # HEAD is a probe, not a download
        fname = path[len("/downloads/"):].split("?")[0]
        ext = fname.rsplit(".", 1)[-1].lower()
        if ext not in FAMILIES:
            continue
        day = when.strftime("%Y-%m-%d")
        if status == "304":
            revalidated[day] = revalidated.get(day, 0) + 1
            continue
        if status not in ("200", "206"):
            continue
        vm = VERSIONED_RE.match(fname)
        version = vm.group(1) if vm else attribute(timeline, ext, when)
        if status == "206":
            key = (day, fname, version, ip, ua)
            if key in partial_seen:
                continue
            partial_seen.add(key)
        per = counts.setdefault(day, {}).setdefault(ext, {})
        per[version] = per.get(version, 0) + 1
    coverage = [first.isoformat(timespec="seconds"), last.isoformat(timespec="seconds")] if first and last else None
    return counts, revalidated, coverage


def day_total(rec) -> int:
    return rec if isinstance(rec, int) else sum(sum(v.values()) for v in rec.values())


def merge_days(stored: dict, fresh: dict):
    """A re-read day replaces the stored one only if it is not smaller: rotation can
    leave the oldest day partially in the logs, and that must not erase history."""
    for day, rec in fresh.items():
        if day not in stored or day_total(rec) >= day_total(stored[day]):
            stored[day] = rec


def load_state() -> dict:
    if not STATE_FILE.is_file():
        return {}
    try:
        return json.loads(STATE_FILE.read_text())
    except json.JSONDecodeError as e:
        # Never overwrite accumulated history with a fresh-only file.
        sys.exit(f"::error title=Corrupt stats state::{STATE_FILE} is not valid JSON ({e}); "
                 "restore it from a backup or move it aside deliberately.")


def save_state(state: dict):
    tmp = STATE_FILE.with_name(STATE_FILE.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
    os.replace(tmp, STATE_FILE)


# ── 3. Rollups ───────────────────────────────────────────────────────────────

def rollup(website: dict):
    per_version: dict = {}
    per_day_totals: dict = {}
    today = datetime.now(timezone.utc).date()
    # Inclusive of today: 7 and 30 calendar days (log days vs. the UTC date of this run).
    windows = {"7d": today - timedelta(days=6), "30d": today - timedelta(days=29)}
    win_totals = {"7d": 0, "30d": 0}
    for day, fams in website.items():
        for fam, versions in fams.items():
            for version, n in versions.items():
                pv = per_version.setdefault(version, {f: 0 for f in FAMILIES})
                pv[fam] += n
        per_day_totals[day] = day_total(fams)
        try:
            d = datetime.strptime(day, "%Y-%m-%d").date()
            for w, cutoff in windows.items():
                if d >= cutoff:
                    win_totals[w] += per_day_totals[day]
        except ValueError:
            pass
    return per_version, per_day_totals, win_totals


# ── 4. Outputs ───────────────────────────────────────────────────────────────

PAGE_CSS = """
:root{--navy:#0a1428;--navy-2:#101d3a;--ink:#e8e3d5;--muted:#8d94a8;--gold:#c08a1c;--gold-bright:#f0d068;--line:rgba(192,138,28,.25)}
*{box-sizing:border-box;margin:0}body{background:var(--navy);color:var(--ink);font:15px/1.6 "Source Sans 3","Segoe UI",system-ui,sans-serif;padding:48px 24px;max-width:960px;margin:0 auto}
h1{font-family:"Source Serif 4",Georgia,serif;font-weight:600;font-size:28px;letter-spacing:.01em}
h1 span{color:var(--gold-bright)}h2{font-size:13px;font-weight:600;color:var(--muted);letter-spacing:.08em;margin:40px 0 12px;border-top:1px solid var(--line);padding-top:16px}
p.sub{color:var(--muted);font-size:13px;margin-top:4px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{font-size:11px;color:var(--muted);text-align:right;font-weight:600;padding:6px 10px;border-bottom:1px solid var(--line)}
th:first-child,td:first-child{text-align:left}td{padding:6px 10px;text-align:right;border-bottom:1px solid rgba(141,148,168,.12);font-size:14px}
td.v{color:var(--gold-bright);font-weight:600}tr.pre td{opacity:.55}
.cards{display:flex;gap:24px;flex-wrap:wrap;margin-top:24px}.card{border:1px solid var(--line);border-radius:12px;padding:16px 22px;min-width:160px}
.card strong{display:block;font-size:26px;font-family:"Source Serif 4",Georgia,serif;color:var(--gold-bright)}.card small{color:var(--muted);font-size:12px}
ul.notes{color:var(--muted);font-size:13px;padding-left:18px}ul.notes li{margin:4px 0}p.warn{color:var(--gold-bright);font-size:13px;margin-top:12px}
footer{margin-top:40px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
"""


def build_page(meta, releases, per_version, per_day_totals, revalidated, win_totals):
    e = html.escape
    gh_total = sum(r["total"] for r in releases)
    upd_total = sum(r.get("updater", 0) for r in releases)
    site_total = sum(per_day_totals.values())
    versions = sorted(
        {v for v in per_version} | {r["tag"].lstrip("v") for r in releases},
        key=semver_key, reverse=True)
    gh_by_version = {r["tag"].lstrip("v"): r for r in releases}

    rows = []
    for v in versions:
        pv = per_version.get(v, {f: 0 for f in FAMILIES})
        gh = gh_by_version.get(v)
        site_sum = sum(pv.values())
        cls = ' class="pre"' if gh and gh["prerelease"] else ""
        rows.append(
            f'<tr{cls}>'
            f'<td class="v">{e(v)}</td>'
            f'<td>{e(gh["published"]) if gh else "—"}</td>'
            f'<td>{gh["total"] if gh else "—"}</td>'
            f'<td>{gh.get("updater", 0) if gh else "—"}</td>'
            f'<td>{pv["exe"]}</td><td>{pv["msi"]}</td><td>{pv["dmg"]}</td>'
            f'<td>{site_sum}</td>'
            f'<td><strong>{(gh["total"] if gh else 0) + site_sum}</strong></td></tr>')

    days = sorted(set(per_day_totals) | set(revalidated), reverse=True)[:14]
    day_rows = [f"<tr><td>{e(d)}</td><td>{per_day_totals.get(d, 0)}</td><td>{revalidated.get(d, 0)}</td></tr>"
                for d in days]

    cov = meta["log_coverage"]
    cov_txt = f"{e(cov[0])} to {e(cov[1])}" if cov else "no requests in the logs read"
    warn = (f'<p class="warn">GitHub API unavailable this run ({e(meta["github_error"])}); '
            f'GitHub figures are the last good fetch from {e(meta["github_fetched"] or "never")}.</p>'
            if meta["github_error"] else "")

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Compass — download log</title><style>{PAGE_CSS}</style></head>
<body>
<h1>Compass <span>download log</span></h1>
<p class="sub">Download requests by version and source. Requests, not people or completed installs. Not linked anywhere.</p>
{warn}
<div class="cards">
<div class="card"><strong>{gh_total}</strong><small>GitHub installer fetches, all time</small></div>
<div class="card"><strong>{upd_total}</strong><small>GitHub in-app update packages, all time</small></div>
<div class="card"><strong>{site_total}</strong><small>website installer requests, recorded</small></div>
<div class="card"><strong>{win_totals["30d"]}</strong><small>website, last 30 days</small></div>
<div class="card"><strong>{win_totals["7d"]}</strong><small>website, last 7 days</small></div>
</div>
<h2>WHAT IS COUNTED</h2>
<ul class="notes">
<li><b>GitHub installers</b>: GitHub's download_count for each release's .exe, .msi and .dmg. GitHub counts every fetch, including automation: the Host Release Downloads job fetches each hosted installer once per stable release, and other fetches may also be automated. Nothing is subtracted.</li>
<li><b>GitHub updates</b>: download_count of the .nsis.zip package that the in-app updater installs (via latest.json). Shown separately and not added to any total. Signatures, latest.json and other assets are not counted anywhere.</li>
<li><b>Website</b>: GET requests for /downloads/*.exe|.msi|.dmg answered 200 or 206 by the server (compass.access.log). Repeated 206 range requests for one file from the same address and user agent on one log day count once. HEAD requests and 304 responses are not counted.</li>
<li><b>Origin 304</b>: conditional requests answered "not modified", e.g. Cloudflare revalidating a cached installer. Shown for context only; a 304 is not proof of a completed download, and downloads served from a cache without contacting the server are not visible here.</li>
<li><b>Installers total</b> = GitHub installers + website for that version.</li>
</ul>
<h2>BY VERSION</h2>
<table><thead><tr><th>Version</th><th>Published</th><th>GitHub installers</th><th>GitHub updates</th><th>Site .exe</th><th>Site .msi</th><th>Site .dmg</th><th>Site total</th><th>Installers total</th></tr></thead>
<tbody>{"".join(rows) or '<tr><td colspan="9">Nothing recorded yet.</td></tr>'}</tbody></table>
<h2>WEBSITE, LAST 14 RECORDED DAYS (SERVER LOG DATE)</h2>
<table><thead><tr><th>Day</th><th>Installer requests</th><th>Origin 304 (not counted)</th></tr></thead>
<tbody>{"".join(day_rows) or '<tr><td colspan="3">Nothing recorded yet.</td></tr>'}</tbody></table>
<footer>Generated {e(meta["updated"])} · refreshed daily around 06:17 UTC · GitHub fetched {e(meta["github_fetched"] or "never")} ·
logs read this run cover {cov_txt} · website history begins when tracking began; GitHub counts are complete history from the API.</footer>
</body></html>
"""


def build_summary(meta, releases, per_version, win_totals):
    lines = ["## Compass downloads", "",
             "| Version | GitHub installers | GitHub updates | Website | Installers total |",
             "|---|---:|---:|---:|---:|"]
    versions = sorted(
        {v for v in per_version} | {r["tag"].lstrip("v") for r in releases},
        key=semver_key, reverse=True)
    gh_by_version = {r["tag"].lstrip("v"): r for r in releases}
    for v in versions[:10]:
        gh = gh_by_version.get(v)
        site = sum(per_version.get(v, {}).values())
        total = (gh["total"] if gh else 0) + site
        flag = " (pre)" if gh and gh["prerelease"] else ""
        lines.append(f"| {v}{flag} | {gh['total'] if gh else '—'} | {gh.get('updater', 0) if gh else '—'} "
                     f"| {site} | {total} |")
    lines += ["", f"Website last 7 days: **{win_totals['7d']}** · last 30 days: **{win_totals['30d']}** (server log days)",
              f"Logs read cover: {meta['log_coverage'] or 'none'} · GitHub fetched: {meta['github_fetched'] or 'never'}"]
    if meta["github_error"]:
        lines.append(f"**GitHub API unavailable this run ({meta['github_error']}); showing last good fetch.**")
    lines.append("Counts are HTTP requests (GitHub includes automation), not people or completed installs.")
    return "\n".join(lines)


def main():
    state = load_state()
    fresh, revalidated, coverage = parse_website_downloads()  # exits before any write if logs are unreadable

    gh_error = None
    try:
        state["github"] = {"fetched": now_utc(), "releases": fetch_github_releases()}
    except Exception as e:  # keep the last good data; never publish zero as fresh
        gh_error = str(e)[:200]
        print(f"::warning title=GitHub API unavailable::{gh_error}", file=sys.stderr)
    out_dir = WEB_ROOT / STATS_DIR
    if "github" not in state and (out_dir / "stats.json").is_file():
        # First run after upgrade: the published page holds the last good GitHub figures.
        prev = json.loads((out_dir / "stats.json").read_text())
        state["github"] = {"fetched": prev.get("github_fetched") or prev.get("updated"),
                           "releases": prev.get("github", [])}
    github = state.get("github") or {"fetched": None, "releases": []}

    merge_days(state.setdefault("website", {}), fresh)
    merge_days(state.setdefault("website_304", {}), revalidated)
    state["updated"] = now_utc()
    per_version, per_day_totals, win_totals = rollup(state["website"])  # before saving: bad state fails here
    save_state(state)
    meta = {"updated": state["updated"], "github_fetched": github["fetched"],
            "github_error": gh_error, "log_coverage": coverage}
    releases = github["releases"]

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(
        build_page(meta, releases, per_version, per_day_totals, state["website_304"], win_totals))
    (out_dir / "stats.json").write_text(json.dumps({
        **meta,
        "github": releases,
        "website_per_version": per_version,
        "website_per_day": per_day_totals,
        "website_304_per_day": state["website_304"],
    }, indent=1, sort_keys=True))

    print(build_summary(meta, releases, per_version, win_totals))


if __name__ == "__main__":
    main()
