#!/usr/bin/env python3
"""Synthetic regression check for generate-download-stats.py (stdlib only, no network).

    python3 scripts/test_download_stats.py
"""
import gzip
import hashlib
import importlib.util
import io
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("stats", HERE / "generate-download-stats.py")
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)
S.AUTOMATION_EVENTS = HERE / "no-such-automation-events-file"  # never the runner's real list
S.RECOGNITION_GLOB = str(HERE / "no-such-recognition-log*")  # never the host's real log

UA = "Mozilla/5.0"


def line(t, method, path, status, ip="1.1.1.1", ua=UA):
    return f'{ip} - - [{t}] "{method} {path} HTTP/2.0" {status} 100 "-" "{ua}"\n'


def fake_api(pages):
    """urlopen stand-in: serves `pages` (list of lists) by ?page=N, or raises an Exception."""
    def urlopen(req, timeout=0):
        if isinstance(pages, Exception):
            raise pages
        n = int(req.full_url.rsplit("page=", 1)[1])
        return io.BytesIO(json.dumps(pages[n - 1] if n <= len(pages) else []).encode())
    return urlopen


def release(i, exe=2, nsis=1):
    return {"tag_name": f"v1.0.{i}", "draft": False, "prerelease": False,
            "published_at": "2026-10-25T00:00:00Z",
            "assets": [{"name": f"Compass_1.0.{i}_x64-setup.exe", "download_count": exe},
                       {"name": f"Compass_1.0.{i}_x64-setup.nsis.zip", "download_count": nsis},
                       {"name": f"Compass_1.0.{i}_x64-setup.nsis.zip.sig", "download_count": 9},
                       {"name": "latest.json", "download_count": 40}]}


def run(tmp):
    S.main()
    return (json.loads(S.STATE_FILE.read_text()),
            json.loads((S.WEB_ROOT / S.STATS_DIR / "stats.json").read_text()))


def main():
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        logs, dl = d / "logs", d / "downloads"
        logs.mkdir(); dl.mkdir()
        S.LOG_GLOB = str(logs / "compass.access.log*")
        S.DOWNLOADS_DIR, S.WEB_ROOT, S.STATE_FILE = dl, d / "web", d / "state.json"

        # 1.3.4 hosted 10-25 18:28Z, 1.3.5 hosted the same day 23:33Z.
        for v, ts in (("1.3.4", "2026-10-25T18:28:00"), ("1.3.5", "2026-10-25T23:33:00")):
            f = dl / f"Compass_{v}_x64-setup.exe"
            f.write_bytes(b"x")
            t = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc).timestamp()
            os.utime(f, (t, t))
        (dl / "Compass.exe").symlink_to(dl / "Compass_1.3.5_x64-setup.exe")

        # Rotated set: .2.gz (oldest) / .1 / current. Unrelated site log must be ignored.
        with gzip.open(logs / "compass.access.log.2.gz", "wt") as fh:
            fh.write(line("25/Oct/2026:20:00:00 +0000", "GET", "/downloads/Compass.exe", "200"))  # -> 1.3.4
            fh.write(line("25/Oct/2026:19:59:00 -0400", "GET", "/downloads/Compass.exe", "200"))  # 23:59Z -> 1.3.5
            # Same client ranges the stable link before and after the 1.3.5 switch: two downloads.
            fh.write(line("25/Oct/2026:20:00:00 +0000", "GET", "/downloads/Compass.exe", "206", ip="3.3.3.3"))
            fh.write(line("25/Oct/2026:23:50:00 +0000", "GET", "/downloads/Compass.exe", "206", ip="3.3.3.3"))
        (logs / "compass.access.log.1").write_text(
            line("26/Oct/2026:10:00:00 +0000", "GET", "/downloads/Compass.exe", "206")
            + line("26/Oct/2026:10:00:01 +0000", "GET", "/downloads/Compass.exe", "206")   # same range burst
            + line("26/Oct/2026:10:00:02 +0000", "GET", "/downloads/Compass.exe", "206", ip="2.2.2.2")
            + line("26/Oct/2026:11:00:00 +0000", "GET", "/downloads/Compass.exe", "304")   # revalidation
            + line("26/Oct/2026:11:00:01 +0000", "HEAD", "/downloads/Compass.exe", "200")  # probe
            + line("26/Oct/2026:11:00:02 +0000", "GET", "/downloads/Compass.exe", "404"))
        (logs / "compass.access.log").write_text(
            line("27/Oct/2026:09:00:00 +0000", "GET", "/downloads/Compass_1.3.4_x64-setup.exe", "200")
            + line("27/Oct/2026:09:00:01 +0000", "GET", "/downloads/latest.json", "200")
            + line("27/Oct/2026:09:00:02 +0000", "GET", "/", "200"))
        (logs.parent / "access.log").write_text(
            line("27/Oct/2026:09:00:00 +0000", "GET", "/downloads/Compass.exe", "200"))  # other site, not globbed

        # GitHub: 2 pages (100 + 3), installers and updater separate, .sig/latest.json excluded.
        S.urllib.request.urlopen = fake_api([[release(i) for i in range(100)], [release(i) for i in range(100, 103)]])
        state, out = run(d)
        assert state["website"] == {
            "2026-10-25": {"exe": {"1.3.4": 2, "1.3.5": 2}},
            "2026-10-26": {"exe": {"1.3.5": 2}},
            "2026-10-27": {"exe": {"1.3.4": 1}},
        }, state["website"]
        assert state["website_304"] == {"2026-10-26": 1}
        assert out["website_per_version"] == {"1.3.4": {"exe": 3, "msi": 0, "dmg": 0},
                                              "1.3.5": {"exe": 4, "msi": 0, "dmg": 0}}
        assert len(out["github"]) == 103, "pagination truncated"
        assert sum(r["total"] for r in out["github"]) == 206
        assert sum(r["updater"] for r in out["github"]) == 103
        assert out["github_error"] is None and out["log_coverage"][0] == "2026-10-25T20:00:00+00:00"
        page = (S.WEB_ROOT / S.STATS_DIR / "index.html").read_text()
        assert ">206<" in page and ">103<" in page and ">7<" in page  # GH installers, GH updates, site recorded

        # Reprocessing the same logs is idempotent.
        state2, _ = run(d)
        assert state2["website"] == state["website"] and state2["website_304"] == state["website_304"]

        # Oldest file rotated away + GitHub down: no recorded day shrinks, last good GitHub kept.
        (logs / "compass.access.log.2.gz").unlink()
        (logs / "compass.access.log.1").write_text(
            line("26/Oct/2026:10:00:00 +0000", "GET", "/downloads/Compass.exe", "206"))  # partial day
        S.urllib.request.urlopen = fake_api(OSError("boom"))
        state3, out3 = run(d)
        assert state3["website"] == state["website"], state3["website"]
        assert len(out3["github"]) == 103 and out3["github_error"] == "boom"
        assert out3["github_fetched"] == state["github"]["fetched"]
        assert "GitHub API unavailable" in (S.WEB_ROOT / S.STATS_DIR / "index.html").read_text()

        # A later, larger read of a day does replace it.
        (logs / "compass.access.log.1").write_text(
            "".join(line(f"26/Oct/2026:12:00:0{i} +0000", "GET", "/downloads/Compass.exe", "200") for i in range(4)))
        assert run(d)[0]["website"]["2026-10-26"] == {"exe": {"1.3.5": 4}}

        # No logs at all, or a corrupt state file: exit without touching state.
        before = S.STATE_FILE.read_text()
        for f in logs.iterdir():
            f.unlink()
        try:
            S.main(); raise AssertionError("expected exit with no logs")
        except SystemExit:
            pass
        assert S.STATE_FILE.read_text() == before
        (logs / "compass.access.log").write_text("")
        S.STATE_FILE.write_text("{not json")
        try:
            S.main(); raise AssertionError("expected exit on corrupt state")
        except SystemExit:
            pass
        assert S.STATE_FILE.read_text() == "{not json"

        # First run after upgrading (legacy state, no cached GitHub) with GitHub down:
        # the previously published GitHub figures are kept, marked stale.
        S.STATE_FILE.write_text(json.dumps({"website": state["website"], "updated": "x"}))
        _, out4 = run(d)
        assert len(out4["github"]) == 103 and out4["github_error"] == "boom"
        # Nothing published and nothing cached: explicit unavailable state, not zero-as-fresh.
        S.STATE_FILE.unlink()
        (S.WEB_ROOT / S.STATS_DIR / "stats.json").unlink()
        _, out5 = run(d)
        assert out5["github"] == [] and out5["github_error"] == "boom" and out5["github_fetched"] is None
    verified_checks()
    display_checks()
    rule2_checks()
    recognition_checks()
    print("download stats checks: OK")


def bline(t, method, path, status, nbytes, ua=UA):
    return f'9.9.9.9 - - [{t}] "{method} {path} HTTP/2.0" {status} {nbytes} "-" "{ua}"\n'


def verified_checks():
    """Byte-verified site transfers: separate from raw, never seeded from legacy raw counts."""
    EXE8, MSI8, DMG8, EXE7 = 6714328, 9310208, 18320908, 6000000
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        logs, dl = d / "logs", d / "downloads"
        logs.mkdir(); dl.mkdir()
        S.LOG_GLOB = str(logs / "compass.access.log*")
        S.DOWNLOADS_DIR, S.WEB_ROOT, S.STATE_FILE = dl, d / "web", d / "state.json"
        # Hosted files (sparse, real sizes). The MSI size is known only from the hosted file.
        for name, size, ts in (("Compass_1.3.7_x64-setup.exe", EXE7, "2026-10-20T00:00:00"),
                               ("Compass_1.3.8_x64-setup.exe", EXE8, "2026-10-28T14:10:25"),
                               ("Compass_1.3.8_x64_en-US.msi", MSI8, "2026-10-28T14:10:25"),
                               ("Compass_1.3.8_aarch64.dmg", DMG8, "2026-10-28T14:10:25")):
            with open(dl / name, "wb") as fh:
                fh.truncate(size)
            t = datetime.fromisoformat(ts).replace(tzinfo=timezone.utc).timestamp()
            os.utime(dl / name, (t, t))
        rel = lambda tag, assets: {"tag_name": tag, "draft": False, "prerelease": False,
                                   "published_at": "2026-10-28T14:03:00Z",
                                   "assets": [{"name": n, "download_count": 1, "size": s} for n, s in assets]}
        S.urllib.request.urlopen = fake_api([[
            rel("v1.3.8", [("Compass_1.3.8_x64-setup.exe", EXE8), ("Compass_1.3.8_x64_en-US.msi", None),
                           ("Compass_1.3.8_aarch64.dmg", DMG8)]),
            rel("v1.3.7", [("Compass_1.3.7_x64-setup.exe", EXE7)])]])
        # Legacy state: the published six raw 1.3.8 requests from 10-28 (logs since rotated away).
        legacy = {"website": {"2026-10-28": {"exe": {"1.3.8": 2}, "msi": {"1.3.8": 2}, "dmg": {"1.3.8": 2}}},
                  "website_304": {"2026-10-27": 8}, "updated": "x"}
        S.STATE_FILE.write_text(json.dumps(legacy))

        T = "29/Oct/2026:10:00:0{} +0000"
        body = "".join([
            bline(T.format(0), "GET", "/downloads/Compass.exe", 200, EXE8),            # complete (stable)
            bline(T.format(1), "GET", "/downloads/Compass.exe", 200, EXE8),            # repeat: still an event
            bline(T.format(2), "GET", "/downloads/Compass_1.3.8_x64-setup.exe", 200, EXE8),  # complete (versioned)
            bline(T.format(3), "GET", "/downloads/Compass.exe", 200, EXE8, ua="curl/8.5.0"),  # curl stays eligible
            bline(T.format(4), "GET", "/downloads/Compass.msi", 200, MSI8),            # size from hosted file
            bline(T.format(5), "GET", "/downloads/Compass.msi", 200, 1024),            # short 200
            bline(T.format(6), "GET", "/downloads/Compass.exe", 200, 0),               # zero bytes
            bline(T.format(7), "GET", "/downloads/Compass.exe", 200, "-"),             # missing bytes
            bline(T.format(8), "GET", "/downloads/Compass.dmg", 206, DMG8),            # range: partial even if full-size
            bline(T.format(9), "HEAD", "/downloads/Compass.exe", 200, 0),              # not counted anywhere
            bline("29/Oct/2026:11:00:00 +0000", "GET", "/downloads/Compass.exe", 304, 0),  # 304 column only
            bline("29/Oct/2026:11:00:01 +0000", "GET", "/downloads/Compass.exe", 200, EXE8,
                  ua="Compass-release-verification/1.0"),                              # our check
            bline("29/Oct/2026:11:00:02 +0000", "GET", "/downloads/Compass.exe?verify=r1", 200, EXE8),
            bline("29/Oct/2026:11:00:03 +0000", "GET", "/downloads/Compass.exe", 200, EXE8,
                  ua="Mozilla/5.0 (compatible; Googlebot/2.1)"),                       # declared crawler
            bline("29/Oct/2026:11:00:04 +0000", "GET", "/downloads/Compass_1.3.7_x64-setup.exe", 200, EXE8),  # other version's size
            bline("29/Oct/2026:11:00:05 +0000", "GET", "/downloads/Compass_1.3.7_x64-setup.exe", 200, EXE7),
            bline("29/Oct/2026:11:00:06 +0000", "GET", "/downloads/Compass_9.9.9_x64-setup.exe", 200, 5),  # size unknown
        ])
        # Mid-rotation: the same file as .1 and .1.gz must be read once.
        (logs / "compass.access.log.1").write_text(body)
        with gzip.open(logs / "compass.access.log.1.gz", "wt") as fh:
            fh.write(body)
        (logs / "compass.access.log").write_text("")
        state, out = run(d)
        sv = out["site_verified"]
        want8 = {"complete": 5, "incomplete": 2, "partial": 1, "unverifiable": 1, "automation": 3}
        want7 = {"complete": 1, "incomplete": 1, "partial": 0, "unverifiable": 0, "automation": 0}
        assert sv["per_version"]["1.3.8"] == want8, sv["per_version"]
        assert sv["per_version"]["1.3.7"] == want7, sv["per_version"]
        assert sv["per_version"]["9.9.9"]["unverifiable"] == 1
        # The six legacy raw requests stay raw; 1.3.8 history before the first verified line is unknown.
        assert state["website"]["2026-10-28"] == legacy["website"]["2026-10-28"]
        assert "2026-10-28" not in state["site_verified"]
        assert sv["since"] == "2026-10-29T10:00:00+00:00" and sv["coverage"]["1.3.8"] == "partial"
        # Logs start mid-day on 10-29, so even 1.3.7 (first seen 10-29) is conservatively partial.
        assert sv["coverage"]["1.3.7"] == "partial" and sv["rule"] == S.VERIFIED_RULE
        assert state["website_304"] == {"2026-10-27": 8, "2026-10-29": 1}
        page = (S.WEB_ROOT / S.STATS_DIR / "index.html").read_text()
        assert "5 (earlier unknown)" in page and "Installers total" not in page
        # Raw request semantics unchanged (gz duplicate not double counted).
        assert state["website"]["2026-10-29"]["exe"]["1.3.8"] == 9, state["website"]["2026-10-29"]

        # Rerun: idempotent. Rotation leaves a partial day: verified history is not lowered.
        assert run(d)[0]["site_verified"] == state["site_verified"]
        (logs / "compass.access.log.1").unlink(); (logs / "compass.access.log.1.gz").unlink()
        (logs / "compass.access.log").write_text(bline(T.format(0), "GET", "/downloads/Compass.exe", 200, EXE8))
        state2, out2 = run(d)
        assert state2["site_verified"] == state["site_verified"]
        assert out2["site_verified"]["since"] == sv["since"]

        # Logs with no 1.3.8 line and only legacy raw: verified is "unknown", never the raw six.
        S.STATE_FILE.write_text(json.dumps(legacy))
        (logs / "compass.access.log").write_text(bline(T.format(0), "GET", "/", 200, 10))
        _, out3 = run(d)
        assert "1.3.8" not in out3["site_verified"]["per_version"]
        # A version first requested after the first verified day is fully covered.
        assert S.rollup_verified({}, {"2026-10-30": {"exe": {"1.3.9": 1}}}, sv["since"])[2] == {"1.3.9": "full"}
        assert out3["site_verified"]["coverage"]["1.3.8"] == "partial"
        assert "| 1.3.8 | 3 | 0 | 6 | unknown |" in S.build_summary(
            {"log_coverage": None, "github_fetched": None, "github_error": None},
            out3["github"], out3["website_per_version"], {"7d": 0, "30d": 0}, out3["site_verified"])


def by_version_row(page, v):
    """Cells after the version in the first (BY VERSION) table row for v."""
    m = re.search(rf'<tr[^>]*><td class="v">{re.escape(v)}</td>(.*?)</tr>', page)
    return re.findall(r"<td>(.*?)</td>", m.group(1))


def display_checks():
    """BY VERSION site columns show verified complete only; raw stays raw, in a diagnostic area."""
    EXE, MSI, DMG, PROBE = 6714328, 9310208, 18320908, 147456
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        logs, dl = d / "logs", d / "downloads"
        logs.mkdir(); dl.mkdir()
        S.LOG_GLOB = str(logs / "compass.access.log*")
        S.DOWNLOADS_DIR, S.WEB_ROOT, S.STATE_FILE = dl, d / "web", d / "state.json"
        names = {}
        for v in ("1.3.8", "1.3.9"):
            names[v] = (f"Compass_{v}_x64-setup.exe", f"Compass_{v}_x64_en-US.msi", f"Compass_{v}_aarch64.dmg")
            for n, size in zip(names[v], (EXE, MSI, DMG)):
                with open(dl / n, "wb") as fh:
                    fh.truncate(size)
        S.urllib.request.urlopen = fake_api([[
            {"tag_name": "v1.3.9", "draft": False, "prerelease": False, "published_at": "2026-10-30T00:00:00Z",
             "assets": [{"name": names["1.3.9"][0], "download_count": 5, "size": EXE},
                        {"name": "Compass_1.3.9_x64-setup.nsis.zip", "download_count": 2, "size": 1}]}]])
        # Legacy raw only: 1.3.8 on 10-28 (before verification) and 1.3.0 (never verified).
        S.STATE_FILE.write_text(json.dumps({"website": {
            "2026-10-28": {"exe": {"1.3.8": 2}}, "2026-09-01": {"msi": {"1.3.0": 4}}}}))
        e8, m8, g8 = (f"/downloads/{n}" for n in names["1.3.8"])
        T = "29/Oct/2026:10:00:0{} +0000"
        body = "".join([
            bline(T.format(0), "GET", e8, 200, EXE),                       # complete
            bline(T.format(1), "GET", e8, 200, EXE, ua="curl/8.5.0"),      # complete (curl eligible)
            bline(T.format(2), "GET", e8, 200, 1024),                      # short
            bline(T.format(3), "GET", m8, 200, MSI),                       # complete
            bline(T.format(4), "GET", g8, 206, DMG),                       # partial
            bline(T.format(5), "GET", g8, 200, PROBE, ua="Hermes"),        # probe
        ] + [bline(f"30/Oct/2026:12:00:0{i} +0000", "GET", f"/downloads/{n}", 200, PROBE, ua="Hermes")
             for i, n in enumerate(names["1.3.9"])])                       # latest: automation only
        (logs / "compass.access.log").write_text(body)
        state, out = run(d)
        page = (S.WEB_ROOT / S.STATS_DIR / "index.html").read_text()
        # Raw data and opaque GitHub/updater figures untouched.
        assert out["website_per_version"]["1.3.9"] == {"exe": 1, "msi": 1, "dmg": 1}
        assert out["website_per_version"]["1.3.8"] == {"exe": 5, "msi": 1, "dmg": 2}
        assert out["site_verified"]["per_version"]["1.3.9"]["automation"] == 3
        # Columns: published, GH installers, GH updates, site .exe, .msi, .dmg, site total.
        assert by_version_row(page, "1.3.9") == ["2026-10-30", "5", "2", "0", "0", "0", "0"], page
        eu = " (earlier unknown)"
        assert by_version_row(page, "1.3.8")[3:] == ["2" + eu, "1" + eu, "0" + eu, "3" + eu]
        assert by_version_row(page, "1.3.0")[3:] == ["unknown"] * 4
        assert out["site_verified"]["per_version_family"]["1.3.8"] == {"exe": 2, "msi": 1, "dmg": 0}
        # Raw totals (which include the probes) only appear in the labelled diagnostic area.
        diag = page.index("DIAGNOSTIC")
        assert diag < page.index("website installer requests (raw), recorded") and \
            '<strong>15</strong><small>website installer requests (raw)' in page[diag:]
        assert page.count("(raw)") == page[diag:].count("(raw)"), "raw figure outside diagnostic area"


def rule2_checks():
    """Rule 2: recognised crawlers and private exact events leave 'complete', including on
    history re-read from retained logs; days whose logs are gone keep rule 1, flagged."""
    EXE, MSI = 6714328, 9310208
    FB = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
    GO = ("Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/153.0.8010.47 Mobile Safari/537.36 (compatible; GoogleOther)")
    for ua in (FB, GO, "GoogleOther", "GoogleOther-Image/1.0", "Mozilla/5.0 facebookexternalhit/1.1 Facebot"):
        assert S.BOT_UA_RE.search(ua), ua
    BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"
    for ua in (BROWSER, "Mozilla/5.0", "curl/8.5.0", "Wget/1.21", "Mozilla/5.0 (Macintosh) Safari/605.1.15"):
        assert not S.BOT_UA_RE.search(ua) and not S.INTERNAL_UA_RE.search(ua), ua
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        logs, dl = d / "logs", d / "downloads"
        logs.mkdir(); dl.mkdir()
        S.LOG_GLOB = str(logs / "compass.access.log*")
        S.DOWNLOADS_DIR, S.WEB_ROOT, S.STATE_FILE = dl, d / "web", d / "state.json"
        for n, size in (("Compass_1.3.9_x64-setup.exe", EXE), ("Compass_1.3.9_x64_en-US.msi", MSI)):
            with open(dl / n, "wb") as fh:
                fh.truncate(size)
            os.utime(dl / n, (1761700000, 1761700000))  # 2025: hosted before every line below
        S.urllib.request.urlopen = fake_api([[]])
        T = "02/Nov/2026:10:00:{:02d} +0000"
        ours = bline(T.format(5), "GET", "/downloads/Compass.exe", 200, EXE, ua=UA)  # internal, browser-shaped
        day = "".join([
            bline(T.format(0), "GET", "/downloads/Compass.exe", 200, EXE, ua=FB),
            bline(T.format(1), "GET", "/downloads/Compass.msi", 200, MSI, ua=FB),
            bline(T.format(2), "GET", "/downloads/Compass.exe", 200, EXE, ua=GO),
            bline(T.format(3), "GET", "/downloads/Compass.exe", 200, EXE, ua=BROWSER),     # stays complete
            bline(T.format(4), "GET", "/downloads/Compass.exe", 200, EXE, ua="curl/8.5.0"),  # stays complete
            ours,
            bline(T.format(6), "GET", "/downloads/Compass.exe", 200, EXE, ua=UA),  # same address+UA: complete
            bline(T.format(7), "GET", "/downloads/Compass.exe", 200, 1024, ua=FB),  # crawler beats size
            bline(T.format(8), "GET", "/downloads/Compass.msi", 206, MSI),         # partial unchanged
            bline(T.format(9), "GET", "/downloads/Compass.msi", 200, 99),          # incomplete unchanged
        ])
        (logs / "compass.access.log.1").write_text(day)
        (logs / "compass.access.log").write_text(bline("03/Nov/2026:09:00:00 +0000", "GET", "/", 200, 10))
        # What rule 1 stored for these exact lines (crawlers and our check counted complete),
        # plus 11-01, whose logs have rotated away since.
        rule1_day = {"exe": {"1.3.9": {"complete": 6, "incomplete": 1}},
                     "msi": {"1.3.9": {"complete": 1, "partial": 1, "incomplete": 1}}}
        gone = {"exe": {"1.3.9": {"complete": 2, "automation": 1}}}
        raw = {"2026-11-01": {"exe": {"1.3.9": 3}}, "2026-11-02": {"exe": {"1.3.9": 7}, "msi": {"1.3.9": 3}}}
        S.STATE_FILE.write_text(json.dumps({
            "website": raw, "site_verified": {"2026-11-01": gone, "2026-11-02": rule1_day},
            "site_verified_from": "2026-11-01T00:00:00+00:00", "site_verified_rule": 1, "updated": "x"}))

        # Private list: one exact line. Missing file = none; malformed file or a hash that
        # matches two lines exits before anything is written.
        S.AUTOMATION_EVENTS = d / "automation-events"
        before = S.STATE_FILE.read_text()
        for bad in ("not-a-hash\n", hashlib.sha256(b"x").hexdigest()[:63] + "\n"):
            S.AUTOMATION_EVENTS.write_text(bad)
            try:
                S.main(); raise AssertionError("expected exit on malformed automation events")
            except SystemExit:
                pass
            assert S.STATE_FILE.read_text() == before
        (logs / "compass.access.log").write_text(ours)  # the same exact line twice in the logs
        S.AUTOMATION_EVENTS.write_text("# ours\n" + hashlib.sha256(ours.rstrip("\n").encode()).hexdigest() + "\n")
        try:
            S.main(); raise AssertionError("expected exit on an ambiguous automation event")
        except SystemExit:
            pass
        assert S.STATE_FILE.read_text() == before
        (logs / "compass.access.log").write_text(bline("03/Nov/2026:09:00:00 +0000", "GET", "/", 200, 10))

        state, out = run(d)
        sv = out["site_verified"]
        new_day = state["site_verified"]["2026-11-02"]
        assert new_day == {"exe": {"1.3.9": {"complete": 3, "automation": 4}},
                           "msi": {"1.3.9": {"automation": 1, "partial": 1, "incomplete": 1}}}, new_day
        # Re-bucketing, not adding: same event total, raw requests untouched, complete may go down.
        assert S.verified_day_total(new_day) == S.verified_day_total(rule1_day) == 10
        assert state["website"] == raw
        assert state["site_verified"]["2026-11-01"] == gone  # logs gone: kept as stored
        assert state["site_verified_rules"] == {"2026-11-02": 2} and sv["rule"] == 2
        assert sv["older_rule_days"] == ["2026-11-01"]
        assert sv["per_version"]["1.3.9"] == {"complete": 5, "incomplete": 1, "partial": 1,
                                              "unverifiable": 0, "automation": 6}
        page = (S.WEB_ROOT / S.STATS_DIR / "index.html").read_text()
        assert "older rule because their logs are gone: 2026-11-01." in page
        # Rerun: idempotent, nothing subtracted twice.
        state2, out2 = run(d)
        assert state2["site_verified"] == state["site_verified"] and out2["site_verified"] == sv
        # The day partly rotates away: smaller re-read keeps the rule-2 buckets.
        (logs / "compass.access.log.1").write_text(day.split("\n", 3)[3])
        state3, _ = run(d)
        assert state3["site_verified"] == state["site_verified"]
        assert state3["site_verified_rules"] == {"2026-11-02": 2}
        # Without the private list (or once its line is gone) that event is complete again
        # if re-read: the list, not a count, carries the correction.
        S.AUTOMATION_EVENTS.unlink()
        (logs / "compass.access.log.1").write_text(day)
        assert run(d)[0]["site_verified"]["2026-11-02"]["exe"]["1.3.9"] == {"complete": 4, "automation": 3}
    S.AUTOMATION_EVENTS = HERE / "no-such-automation-events-file"


def recognition_checks():
    """Opt-in counting: rolling 7 days, distinct IDs, 2+ UTC days; never an ID in state/output;
    not started -> absent; started then missing -> unavailable, not zero."""
    now = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)
    ts = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()
    A, B, C, OLD = "a" * 32, "b" * 32, "c" * 32, "d" * 32
    rows = [(A, "2026-11-19T23:59:59"), (A, "2026-11-20T00:00:01"), (B, "2026-11-20T08:00:00"),
            (B, "2026-11-20T09:00:00"), (OLD, "2026-11-13T11:59:59"), (C, "2026-11-14T00:00:00")]
    body = "".join(json.dumps({"v": 1, "t": ts(t), "id": i}) + "\n" for i, t in rows)
    body += 'not json\n{"v":1,"t":1,"id":"ZZ"}\n{"v":1,"t":"x","id":"' + "e" * 32 + '"}\n'
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        S.RECOGNITION_GLOB = str(d / "compass-recognition.jsonl*")
        state = {}
        assert S.recognition_counts(state, now) is None and state == {}  # not started: nothing
        (d / "compass-recognition.jsonl").write_text(body[: len(body) // 2])
        with gzip.open(d / "compass-recognition.jsonl.1.gz", "wt") as fh:
            fh.write(body[len(body) // 2:])
        (d / "compass-recognition.jsonl.1").write_text(body[len(body) // 2:])  # mid-rotation twin
        r = S.recognition_counts(state, now)
        assert r == {"available": True, "window_days": 7, "window_start": "2026-11-13T12:00Z",
                     "window_end": "2026-11-20T12:00Z", "browsers": 3, "multi_day": 1, "partial": True}, r
        assert state == {"recognition_seen_from": "2026-11-20"}
        later = datetime(2026, 11, 28, 12, 0, tzinfo=timezone.utc)
        assert S.recognition_counts(state, later)["partial"] is False
        for f in d.iterdir():
            f.unlink()
        assert S.recognition_counts(state, later) == {"available": False}  # started, then missing
        # End to end through main(): the aggregate is published, no ID reaches state or output.
        (d / "compass-recognition.jsonl").write_text(json.dumps({"v": 1, "t": time.time(), "id": A}) + "\n")
        logs = d / "logs"; logs.mkdir()
        S.LOG_GLOB = str(logs / "compass.access.log*")
        (logs / "compass.access.log").write_text("")
        S.DOWNLOADS_DIR, S.WEB_ROOT, S.STATE_FILE = d / "dl", d / "web", d / "state.json"
        S.urllib.request.urlopen = fake_api([[release(1)]])
        st, out = run(d)
        assert out["recognition"]["browsers"] == 1 and out["recognition"]["available"] is True
        blob = S.STATE_FILE.read_text() + (S.WEB_ROOT / S.STATS_DIR / "stats.json").read_text() \
            + (S.WEB_ROOT / S.STATS_DIR / "index.html").read_text()
        assert A not in blob
    S.RECOGNITION_GLOB = str(HERE / "no-such-recognition-log*")


if __name__ == "__main__":
    main()
