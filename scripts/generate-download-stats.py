#!/usr/bin/env python3
"""Compass download statistics generator.

Runs on the nginx self-hosted runner (see .github/workflows/download-stats.yml).
Gathers two independent sources:

  1. GitHub release asset download counts - the GitHub API already tracks
     `download_count` per asset per release, so per-version numbers are free.
  2. Website downloads - parsed from a plain-text dump of the nginx access
     logs (the workflow concatenates access.log* including rotated .gz files
     into one file first, since /var/log/nginx is root-readable).

Website hits on the stable symlink names (Compass.exe / .msi / .dmg) are
attributed to a version by comparing the request date against the mtimes of
the versioned files in the downloads dir - the Host Release Downloads workflow
writes Compass_<version>_... there each release, so "newest versioned file
whose mtime is on/before the request day" is the version the symlink served.

Because Ubuntu's logrotate only keeps ~14 days of nginx logs, per-day counts
are merged into a persistent state file so history accumulates across runs
instead of vanishing with rotation.

Outputs:
  - <WEB_ROOT>/<STATS_DIR>/index.html   hidden, noindex stats page
  - <WEB_ROOT>/<STATS_DIR>/stats.json   same data, machine-readable
  - stdout                              Markdown summary (piped to the
                                        Actions step summary / email body)

Environment (all optional except when noted):
  REPO           owner/repo for the GitHub API        (default tylahfam97/Compass)
  GH_TOKEN       token for API rate limits            (recommended in CI)
  LOG_DUMP       plain-text nginx access log dump     (required for website stats)
  DOWNLOADS_DIR  hosted installers dir                (default /var/www/compass/downloads)
  WEB_ROOT       website document root                (default /var/www/compass/website)
  STATS_DIR      page directory name under WEB_ROOT   (default "stats")
  STATE_FILE     accumulated per-day counts           (default ~/.compass-download-stats-state.json)
"""

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
LOG_DUMP = os.environ.get("LOG_DUMP", "")
DOWNLOADS_DIR = Path(os.environ.get("DOWNLOADS_DIR", "/var/www/compass/downloads"))
WEB_ROOT = Path(os.environ.get("WEB_ROOT", "/var/www/compass/website"))
STATS_DIR = os.environ.get("STATS_DIR", "stats")
STATE_FILE = Path(os.environ.get("STATE_FILE", str(Path.home() / ".compass-download-stats-state.json")))

FAMILIES = ("exe", "msi", "dmg")
VERSIONED_RE = re.compile(r"^Compass_(\d+\.\d+\.\d+)_.*\.(exe|msi|dmg)$", re.IGNORECASE)
# nginx "combined" format: ip - user [time] "METHOD path HTTP/x" status bytes "referer" "ua"
LOG_RE = re.compile(
    r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^" ]+)[^"]*" (\d{3}) (\S+) "[^"]*" "([^"]*)"'
)
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def semver_key(v: str):
    try:
        return tuple(int(p) for p in v.split("."))
    except ValueError:
        return (0,)


# ── 1. GitHub release download counts ────────────────────────────────────────

def fetch_github_releases():
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/releases?per_page=100",
        headers={"Accept": "application/vnd.github+json",
                 **({"Authorization": f"Bearer {GH_TOKEN}"} if GH_TOKEN else {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            releases = json.load(resp)
    except Exception as e:  # network trouble must not kill the website stats
        print(f"warning: GitHub API unavailable ({e})", file=sys.stderr)
        return []
    out = []
    for r in releases:
        if r.get("draft"):
            continue
        assets = [
            {"name": a["name"], "count": a["download_count"]}
            for a in r.get("assets", [])
            if a["name"].lower().endswith((".exe", ".msi", ".dmg"))
        ]
        out.append({
            "tag": r.get("tag_name", "?"),
            "prerelease": bool(r.get("prerelease")),
            "published": (r.get("published_at") or "")[:10],
            "assets": assets,
            "total": sum(a["count"] for a in assets),
        })
    return out


# ── 2. Website downloads from nginx logs ─────────────────────────────────────

def version_timeline():
    """Per family: [(hosted_date, version)] sorted ascending, from file mtimes."""
    timeline = {f: [] for f in FAMILIES}
    if DOWNLOADS_DIR.is_dir():
        for p in DOWNLOADS_DIR.iterdir():
            m = VERSIONED_RE.match(p.name)
            if m and not p.is_symlink():
                day = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%d")
                timeline[m.group(2).lower()].append((day, m.group(1)))
    for fam in timeline:
        timeline[fam].sort()
    return timeline


def attribute(timeline, fam: str, day: str) -> str:
    version = None
    for hosted_day, v in timeline.get(fam, []):
        if hosted_day <= day:
            version = v
        else:
            break
    return version or "unknown"


def read_dump_lines():
    if not LOG_DUMP:
        return
    path = Path(LOG_DUMP)
    if not path.is_file():
        return
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", errors="replace") as fh:
        yield from fh


def parse_website_downloads():
    """{day: {family: {version: count}}} for days present in the current logs."""
    timeline = version_timeline()
    counts: dict = {}
    partial_seen = set()  # (day, path, ip, ua) - download managers send many 206s per file
    for line in read_dump_lines():
        m = LOG_RE.match(line)
        if not m:
            continue
        ip, when, method, path, status, _bytes, ua = m.groups()
        if method != "GET" or status not in ("200", "206") or not path.startswith("/downloads/"):
            continue
        fname = path[len("/downloads/"):].split("?")[0]
        ext = fname.rsplit(".", 1)[-1].lower()
        if ext not in FAMILIES:
            continue
        try:  # 10/Sep/2026:13:55:36 +0000
            day = f"{when[7:11]}-{MONTHS[when[3:6]]:02d}-{when[0:2]}"
        except KeyError:
            continue
        if status == "206":
            key = (day, fname, ip, ua)
            if key in partial_seen:
                continue
            partial_seen.add(key)
        vm = VERSIONED_RE.match(fname)
        version = vm.group(1) if vm else attribute(timeline, ext, day)
        counts.setdefault(day, {}).setdefault(ext, {})
        counts[day][ext][version] = counts[day][ext][version] + 1 if version in counts[day][ext] else 1
    return counts


def merge_state(fresh: dict) -> dict:
    """Days still in the logs replace stored days; rotated-away days are kept."""
    state = {"website": {}}
    if STATE_FILE.is_file():
        try:
            state = json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            pass
    website = state.setdefault("website", {})
    website.update(fresh)
    state["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    STATE_FILE.write_text(json.dumps(state, indent=1, sort_keys=True))
    return state


# ── 3. Rollups ───────────────────────────────────────────────────────────────

def rollup(website: dict):
    per_version: dict = {}
    per_day_totals: dict = {}
    today = datetime.now(timezone.utc).date()
    windows = {"7d": today - timedelta(days=7), "30d": today - timedelta(days=30)}
    win_totals = {"7d": 0, "30d": 0}
    for day, fams in website.items():
        day_total = 0
        for fam, versions in fams.items():
            for version, n in versions.items():
                pv = per_version.setdefault(version, {f: 0 for f in FAMILIES})
                pv[fam] += n
                day_total += n
        per_day_totals[day] = day_total
        try:
            d = datetime.strptime(day, "%Y-%m-%d").date()
            for w, cutoff in windows.items():
                if d >= cutoff:
                    win_totals[w] += day_total
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
footer{margin-top:40px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
"""


def build_page(releases, per_version, per_day_totals, win_totals, updated):
    e = html.escape
    gh_total = sum(r["total"] for r in releases)
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
            f'<td>{pv["exe"]}</td><td>{pv["msi"]}</td><td>{pv["dmg"]}</td>'
            f'<td>{site_sum}</td>'
            f'<td><strong>{(gh["total"] if gh else 0) + site_sum}</strong></td></tr>')

    day_rows = []
    for day in sorted(per_day_totals, reverse=True)[:14]:
        day_rows.append(f"<tr><td>{e(day)}</td><td>{per_day_totals[day]}</td></tr>")

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Compass — download log</title><style>{PAGE_CSS}</style></head>
<body>
<h1>Compass <span>download log</span></h1>
<p class="sub">GitHub release assets and website installer downloads, by version. Not linked anywhere; for the keeper of the ship.</p>
<div class="cards">
<div class="card"><strong>{gh_total}</strong><small>GitHub, all time</small></div>
<div class="card"><strong>{site_total}</strong><small>website, recorded</small></div>
<div class="card"><strong>{win_totals["30d"]}</strong><small>website, last 30 days</small></div>
<div class="card"><strong>{win_totals["7d"]}</strong><small>website, last 7 days</small></div>
</div>
<h2>BY VERSION</h2>
<table><thead><tr><th>Version</th><th>Published</th><th>GitHub</th><th>Site .exe</th><th>Site .msi</th><th>Site .dmg</th><th>Site total</th><th>Total</th></tr></thead>
<tbody>{"".join(rows) or '<tr><td colspan="8">Nothing recorded yet.</td></tr>'}</tbody></table>
<h2>WEBSITE, LAST 14 RECORDED DAYS</h2>
<table><thead><tr><th>Day</th><th>Downloads</th></tr></thead>
<tbody>{"".join(day_rows) or '<tr><td colspan="2">Nothing recorded yet.</td></tr>'}</tbody></table>
<footer>Updated {e(updated)} · website counts begin when tracking began; GitHub counts are complete history from the API.</footer>
</body></html>
"""


def build_summary(releases, per_version, win_totals):
    lines = ["## Compass downloads", "",
             "| Version | GitHub | Website | Total |", "|---|---:|---:|---:|"]
    versions = sorted(
        {v for v in per_version} | {r["tag"].lstrip("v") for r in releases},
        key=semver_key, reverse=True)
    gh_by_version = {r["tag"].lstrip("v"): r for r in releases}
    for v in versions[:10]:
        gh = gh_by_version.get(v)
        site = sum(per_version.get(v, {}).values())
        total = (gh["total"] if gh else 0) + site
        flag = " (pre)" if gh and gh["prerelease"] else ""
        lines.append(f"| {v}{flag} | {gh['total'] if gh else '—'} | {site} | {total} |")
    lines += ["", f"Website last 7 days: **{win_totals['7d']}** · last 30 days: **{win_totals['30d']}**"]
    return "\n".join(lines)


def main():
    releases = fetch_github_releases()
    fresh = parse_website_downloads()
    state = merge_state(fresh)
    per_version, per_day_totals, win_totals = rollup(state["website"])

    out_dir = WEB_ROOT / STATS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    updated = state.get("updated", "")
    (out_dir / "index.html").write_text(
        build_page(releases, per_version, per_day_totals, win_totals, updated))
    (out_dir / "stats.json").write_text(json.dumps({
        "updated": updated,
        "github": releases,
        "website_per_version": per_version,
        "website_per_day": per_day_totals,
    }, indent=1, sort_keys=True))

    print(build_summary(releases, per_version, win_totals))


if __name__ == "__main__":
    main()
