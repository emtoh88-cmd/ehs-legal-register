#!/usr/bin/env python3
"""
backfill_history.py — reconstruct Change-log entries missing since 2024-Q1.

Root cause of the gap: sso_refresh.py's change detection treats an instrument's
first-ever check (empty prior version_date) as "baseline, not a change" -- correct,
to avoid flagging every instrument as changed the first time it's checked. But the
September 2026 catch-up run was exactly that first-ever check for every instrument,
so every real amendment SSO already listed at that point -- some dated well into
2025 -- went straight into index[].amendments as baseline and never produced a
pending_review / history entry. The index itself is accurate (it reflects SSO's
current state); the Change log just never recorded how it got there for anything
after 2024-Q1 (no 1575, the vendor compilation's own last entry).

This script re-derives the missing entries directly from SSO's version-history
timeline for each instrument (a <li> per amending instrument, pairing it with the
exact date it took effect), which is more precise than the version_date/amendments
tracked for day-to-day change detection. For each amending instrument not already
present in history (matched by its gazette number, unique register-wide), it follows
SSO's own redirect to that instrument's page to read its official title -- the same
detail level as every existing history entry.

Usage:
  python backfill_history.py --dry-run          # show what would be added
  python backfill_history.py --dry-run --limit 5
  python backfill_history.py                    # write register.json
Respects the same SSO ToS window (3am-7am SGT) as sso_refresh.py; --force is for a
small manual test only.
"""
import argparse, json, re, time
from datetime import datetime, timezone, timedelta

import httpx
from selectolax.parser import HTMLParser

SGT      = timezone(timedelta(hours=8))
BASE     = "https://sso.agc.gov.sg"
REGISTER = "register.json"
DELAY    = 1.5
TIMEOUT  = 30
UA       = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# contents[].cat -> the category label already used in history[]. Derived by
# cross-referencing the vendor's own 434 existing entries against register.json's
# contents tree; low-confidence single-sample mappings are noted.
CAT_MAP = {
    "1 Key Environmental Legislation": "Environment",
    "2 Controlled Chemicals": "Controlled substances",
    "3 Radiation Protection": "Controlled substances",   # low confidence: 1 sample only
    "4 Marine Pollution": "Marine Pollution",
    "5 Safety and Health": "Safety and Health",
    "6 Fire Safety": "Fire Safety",
    "7 Energy": "Energy",
    "8 Resource Conservation": "Resource Conservation",
    "9 Buildining Sustainability": "Sustainability",
}


def sgt_now():
    return datetime.now(SGT)


def in_window():
    return 3 <= sgt_now().hour < 7


def get(client, url):
    r = client.get(url)
    time.sleep(DELAY)
    r.raise_for_status()
    return r


def quarter_of(date_iso):
    y, m = date_iso.split("-")[:2]
    return f"{y}-{(int(m) - 1) // 3 + 1}Q"


def clean_title(html_title):
    return re.sub(r"\s*-\s*Singapore Statutes Online\s*$", "", html_title or "").strip()


def parse_timeline(html):
    """Return {vide_code: (wef_iso, amend_href)} for one instrument's SSO page.

    SSO renders the version-history list twice (desktop + a 'mobile' duplicate
    with no date attached) -- keep only the entry that has a real date.
    """
    tree = HTMLParser(html)
    out = {}
    for li in tree.css("li"):
        label = next((s for s in li.css("span") if (s.text() or "").strip() == "Amended by"), None)
        if not label:
            continue
        a = li.css_first("div.group_status a")
        if not a:
            continue
        vide = (a.text() or "").strip()
        href = a.attributes.get("href", "")
        ts = li.css_first("div.timestamp a")
        wef_text = (ts.text() or "").strip() if ts else ""
        try:
            wef_iso = datetime.strptime(wef_text, "%d %b %Y").date().isoformat()
        except ValueError:
            continue
        if vide and (vide not in out or not out[vide][0]):
            out[vide] = (wef_iso, href)
    return out


def cat_for(citation, contents_by_citation, log):
    c = contents_by_citation.get(citation)
    if not c:
        return "Miscellaneous"
    return CAT_MAP.get(c.get("cat"), c.get("cat", "Miscellaneous"))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=0, help="check only the first N instruments (testing)")
    p.add_argument("--dry-run", action="store_true", help="do not write register.json")
    p.add_argument("--force", action="store_true", help="ignore the 3-7am SGT window (small tests only)")
    args = p.parse_args()

    def log(m):
        print(m, flush=True)

    now = sgt_now()
    log(f"SGT now: {now:%Y-%m-%d %H:%M}")
    if not in_window() and not args.force:
        log("Outside the 3am-7am SGT extraction window permitted by SSO's Terms of Use. Exiting.")
        return 0

    reg = json.load(open(REGISTER, encoding="utf-8"))
    contents_by_citation = {c["citation"]: c for c in reg["contents"] if c.get("citation")}
    known_vide = {h["vide"] for h in reg["history"]}
    max_no = max(int(h["no"]) for h in reg["history"])
    baseline_wef = max(h["wef"] for h in reg["history"] if re.match(r"\d{4}-\d{2}-\d{2}", h.get("wef", "")))
    log(f"{len(known_vide)} amendments already in history; last recorded wef {baseline_wef}, no {max_no}")

    targets = [e for e in reg["index"] if e.get("sso")]
    if args.limit:
        targets = targets[: args.limit]
    log(f"scanning {len(targets)} instrument timelines")

    # vide -> (wef_iso, href, category, first_seen_citation)
    candidates = {}
    headers = {"User-Agent": UA, "Accept": "text/html"}
    with httpx.Client(headers=headers, timeout=TIMEOUT, follow_redirects=True) as client:
        for i, e in enumerate(targets, 1):
            try:
                html = get(client, BASE + e["sso"]).text
            except Exception as ex:
                log(f"  ! {e['citation']}: {ex}")
                continue
            for vide, (wef_iso, href) in parse_timeline(html).items():
                if vide in known_vide or vide in candidates:
                    continue
                candidates[vide] = (wef_iso, href, cat_for(e["citation"], contents_by_citation, log), e["citation"])
            if i % 25 == 0:
                log(f"  {i}/{len(targets)}")

        log(f"{len(candidates)} amending instruments not yet in history; resolving their titles")
        new_entries = []
        anomalies = []
        for vide, (wef_iso, href, category, parent) in candidates.items():
            if wef_iso <= baseline_wef:
                anomalies.append((vide, wef_iso, parent))
                continue
            try:
                r = get(client, BASE + href)
                m = re.search(r"<title>(.*?)</title>", r.text, re.S)
                title = clean_title(m.group(1)) if m else vide
            except Exception as ex:
                log(f"  ! title lookup failed for {vide}: {ex}")
                title = f"{parent} — amended by {vide}"
            new_entries.append({
                "quarter": quarter_of(wef_iso),
                "no": None,  # assigned after chronological sort, below
                "category": category,
                "title": title,
                "wef": wef_iso,
                "vide": vide,
            })

    if anomalies:
        log(f"{len(anomalies)} candidates dated at/before the existing baseline ({baseline_wef}) "
            f"were skipped as likely parse anomalies, not added:")
        for vide, wef_iso, parent in anomalies:
            log(f"  - {vide} ({wef_iso}) via {parent}")

    new_entries.sort(key=lambda h: (h["wef"], h["title"]))
    for i, h in enumerate(new_entries, 1):
        h["no"] = str(max_no + i)

    log(f"{len(new_entries)} new Change-log entries to add "
        f"({new_entries[0]['wef'] if new_entries else '—'} to {new_entries[-1]['wef'] if new_entries else '—'})")
    for h in new_entries:
        log(f"  {h['no']}  {h['wef']}  {h['category']:<24} {h['title']}  ({h['vide']})")

    if args.dry_run or not new_entries:
        log("dry run -- register.json not written" if args.dry_run else "nothing to write")
        return 0

    reg["history"].extend(new_entries)
    reg["meta"]["counts"]["history"] = len(reg["history"])
    tmp = REGISTER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reg, f, separators=(",", ":"), ensure_ascii=False)
    import os
    os.replace(tmp, REGISTER)
    log(f"wrote {REGISTER}: history now {len(reg['history'])} entries")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
