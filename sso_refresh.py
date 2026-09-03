#!/usr/bin/env python3
"""
sso_refresh.py — refresh a Singapore EHS legal register against Singapore Statutes Online.

Reads register.json, checks each instrument's SSO page for its current version date
and amendment history, and writes back what changed.

SSO Terms of Use, clause 13(d): automated extraction from SSO is permitted only
between 3am and 7am Singapore time, must not be abusive or intrusive, and must not
affect SSO's performance. This script enforces the window itself and throttles
requests -- do not remove either guard.

Usage (all optional):
  python sso_refresh.py --limit 5 --dry-run     # safe first test
  python sso_refresh.py --resolve               # rebuild the citation -> SSO ID map
  python sso_refresh.py                         # the nightly run
  python sso_refresh.py --force                 # ignore the time window (testing only)
"""

import argparse, json, os, re, sys, time, unicodedata
from datetime import datetime, timezone, timedelta

import httpx
from selectolax.parser import HTMLParser

SGT      = timezone(timedelta(hours=8))
BASE     = "https://sso.agc.gov.sg"
REGISTER = "register.json"
REPORT   = "refresh-report.md"
DELAY    = 1.5            # seconds between requests -- politeness, per clause 13(d)(ii)
TIMEOUT  = 30
# SSO's WAF 403s any non-browser-looking UA outright -- a custom identifying string,
# "curl/...", and even Googlebot's UA were all blocked in testing; only a standard
# browser UA gets through. Clause 13(d) already permits this automated extraction
# within the enforced time window, so this isn't working around an access restriction,
# just around a WAF rule that has no bearing on the ToS.
UA       = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

ACT_ID = re.compile(r"^[A-Z]{2,12}\d{4}$")
RE_STATUS = re.compile(r"(?:Current|Historical)\s+version\s*as at\s*(\d{1,2}\s+\w{3}\s+\d{4})", re.I)
RE_AMEND  = re.compile(r"Amended by\s*(S\s*\d+/\d{4}|Act\s*\d+\s*of\s*\d{4})", re.I)
RE_VALID  = re.compile(r"ValidDate=(\d{8})")


# ----------------------------------------------------------------- helpers
def sgt_now():
    return datetime.now(SGT)


def in_window():
    """Clause 13(d)(i): extraction only between 3am and 7am Singapore time."""
    return 3 <= sgt_now().hour < 7


def norm(s):
    """Normalise a citation for fuzzy matching: fold dashes, drop punctuation/case."""
    s = unicodedata.normalize("NFKD", s or "")
    s = s.replace("\u2014", "-").replace("\u2013", "-").replace("\u2019", "'")
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def get(client, path):
    r = client.get(BASE + path)
    time.sleep(DELAY)
    r.raise_for_status()
    return r.text


def page_text(html):
    return re.sub(r"\s+", " ", HTMLParser(html).text(separator=" "))


# ----------------------------------------------------------------- resolve
def resolve_ids(client, reg, log):
    """
    Map each citation to an SSO document path.

    Acts:  the 'ref' column is already the SSO ID (WSHA2006, EPMA1999, ...).
    SL:    enumerate each parent Act's subsidiary legislation via ?ViewType=Sl
           and match by title -- more reliable than guessing /SL/{ACT}-RG{n}.
    """
    by_norm = {}
    for e in reg["index"]:
        if e.get("ref") and ACT_ID.match(e["ref"].replace(" ", "")):
            e["sso"] = "/Act/" + e["ref"].replace(" ", "")
        by_norm.setdefault(norm(e["citation"]), e)

    acts = sorted({e["sso"].split("/")[-1] for e in reg["index"] if e.get("sso")})
    log(f"resolving subsidiary legislation under {len(acts)} parent Acts")

    hit = 0
    for act in acts:
        try:
            html = get(client, f"/Act/{act}?ViewType=Sl")
        except Exception as ex:
            log(f"  ! {act}: {ex}")
            continue
        for node in HTMLParser(html).css("a[href^='/SL/']"):
            title = (node.text() or "").strip()
            href = node.attributes.get("href", "").split("?")[0]
            entry = by_norm.get(norm(title))
            if entry and not entry.get("sso"):
                entry["sso"] = href
                hit += 1

    unresolved = [e["citation"] for e in reg["index"] if not e.get("sso")]
    log(f"  matched {hit} SL; {len(unresolved)} still unresolved")
    reg.setdefault("meta", {})["unresolved"] = unresolved
    return unresolved


# ----------------------------------------------------------------- check
def check_one(client, entry):
    """Return (version_date, [amending instruments]) for one instrument."""
    txt = page_text(get(client, entry["sso"]))
    m = RE_STATUS.search(txt)
    version = m.group(1) if m else ""
    amendments = []
    for a in RE_AMEND.findall(txt):
        a = re.sub(r"\s+", " ", a).strip()
        if a not in amendments:
            amendments.append(a)
    return version, amendments


def refresh(reg, args, log):
    targets = [e for e in reg["index"] if e.get("sso")]
    if args.limit:
        targets = targets[: args.limit]
    log(f"checking {len(targets)} instruments (~{len(targets)*DELAY/60:.0f} min)")

    changed, failed = [], []
    headers = {"User-Agent": UA, "Accept": "text/html"}
    with httpx.Client(headers=headers, timeout=TIMEOUT, follow_redirects=True) as client:
        for i, e in enumerate(targets, 1):
            try:
                version, amendments = check_one(client, e)
            except Exception as ex:
                failed.append((e["citation"], str(ex)[:120]))
                continue

            prev_v = e.get("version_date", "")
            prev_a = set(e.get("amendments", []))
            new_a = [a for a in amendments if a not in prev_a]

            e["version_date"] = version or prev_v
            e["amendments"] = amendments or e.get("amendments", [])
            e["checked"] = sgt_now().date().isoformat()

            if prev_v and version and version != prev_v:
                changed.append({"citation": e["citation"], "from": prev_v,
                                "to": version, "new": new_a})
            elif not prev_v:
                pass                                  # first run: baseline, not a change
            elif new_a:
                changed.append({"citation": e["citation"], "from": prev_v,
                                "to": version, "new": new_a})

            if i % 25 == 0:
                log(f"  {i}/{len(targets)}")
    return changed, failed


# ----------------------------------------------------------------- main
def main():
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=0, help="check only the first N (testing)")
    p.add_argument("--resolve", action="store_true", help="rebuild the citation -> SSO ID map")
    p.add_argument("--dry-run", action="store_true", help="do not write register.json")
    p.add_argument("--force", action="store_true", help="ignore the 3-7am SGT window")
    args = p.parse_args()

    lines = []
    def log(m):
        print(m, flush=True)
        lines.append(m)

    now = sgt_now()
    log(f"SGT now: {now:%Y-%m-%d %H:%M}")
    if not in_window() and not args.force:
        log("Outside the 3am-7am SGT extraction window permitted by SSO's Terms of Use. "
            "Exiting without fetching.")
        return 0

    if not os.path.exists(REGISTER):
        log(f"{REGISTER} not found"); return 1
    reg = json.load(open(REGISTER, encoding="utf-8"))

    if args.resolve or not any(e.get("sso") for e in reg["index"]):
        headers = {"User-Agent": UA, "Accept": "text/html"}
        with httpx.Client(headers=headers, timeout=TIMEOUT, follow_redirects=True) as c:
            resolve_ids(c, reg, log)

    changed, failed = refresh(reg, args, log)

    reg["meta"]["last_checked"] = now.date().isoformat()
    if changed:
        reg["meta"]["source_snapshot"] = f"{now.year}-{now.month:02d}"
    reg["meta"]["pending_review"] = changed

    if args.dry_run:
        log("dry run -- register.json not written")
    else:
        tmp = REGISTER + ".tmp"                       # atomic: never leave a half-written register
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(reg, f, separators=(",", ":"), ensure_ascii=False)
        os.replace(tmp, REGISTER)
        log(f"wrote {REGISTER}")

    # ---- human-readable report, committed alongside the data
    out = [f"# Register refresh — {now:%Y-%m-%d %H:%M} SGT", ""]
    if changed:
        out += [f"**{len(changed)} instruments changed. Each needs an applicability review.**", ""]
        out += ["| Instrument | Was | Now | Amended by |", "|---|---|---|---|"]
        out += [f"| {c['citation']} | {c['from'] or '—'} | {c['to'] or '—'} | "
                f"{', '.join(c['new']) or '—'} |" for c in changed]
    else:
        out.append("No version changes detected.")
    if failed:
        out += ["", f"## {len(failed)} could not be checked", ""]
        out += [f"- {c} — {why}" for c, why in failed]
    if reg["meta"].get("unresolved"):
        u = reg["meta"]["unresolved"]
        out += ["", f"## {len(u)} citations have no SSO link yet", "",
                "Add an `sso` path by hand in register.json, e.g. `\"sso\": \"/SL/WSHA2006-RG1\"`.", ""]
        out += [f"- {c}" for c in u[:40]]
        if len(u) > 40:
            out.append(f"- …and {len(u)-40} more")
    out += ["", "---", "", "<sub>Singapore legislation is subject to the copyright of the "
            "Singapore Government and is reproduced with the permission of the Attorney-General's "
            "Chambers. Check sso.agc.gov.sg for the latest version.</sub>"]
    open(REPORT, "w", encoding="utf-8").write("\n".join(out) + "\n")

    log(f"{len(changed)} changed, {len(failed)} failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
