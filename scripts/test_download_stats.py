#!/usr/bin/env python3
"""Synthetic regression check for generate-download-stats.py (stdlib only, no network).

    python3 scripts/test_download_stats.py
"""
import gzip
import importlib.util
import io
import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("stats", HERE / "generate-download-stats.py")
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)

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


if __name__ == "__main__":
    main()
