#!/usr/bin/env python3
"""Clears the _blockTriageLowDensity property from every task in one or more
live MapRoulette challenges - a one-off cleanup for anyone who no longer
wants to use the low-density exemption (see README.md's "Low density
exemption" section), now that address-count mode gives a more direct way to
gauge density. This is a standalone script, not part of the front-end app -
it never touches local.html's own (separately-stored) low-density marks.

Setup:
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt

Usage:
    python3 clear_low_density.py --challenge 12345 [--challenge 67890]
    MAPROULETTE_API_KEY=... python3 clear_low_density.py --challenge 12345 --apply

Options:
    --challenge ID    A challenge ID to clean up. Repeatable, and/or a
                      comma-separated list (--challenge 111,222).
    --api-key KEY     MapRoulette API key. Falls back to the
                      MAPROULETTE_API_KEY env var (preferred, so the key
                      doesn't end up in your shell history).
    --apply           Actually perform the updates. Without this, the
                      script only reports what it *would* do - always do a
                      dry run first, especially the first time you run this
                      against a given MapRoulette instance (see the note
                      below).

How it clears the flag: fetches each task in full (GET /challenge/{id}/
tasks), then for any task with _blockTriageLowDensity: true on one of its
geometry features, sends the same task back via PUT /task/{id} with just
that property deleted - status, id, name, and everything else about the
task are left exactly as fetched. This mirrors how the app itself treats
MapRoulette as the source of truth, but unlike the app (which deletes and
recreates a task for any edit, including this property, since it usually
also needs to change geometry) this uses a real in-place update so a
task's review/completion status and history aren't disturbed.

NOTE: this script's use of PUT /task/{id} for an in-place update hasn't
been verified against MapRoulette's live API from the environment this was
written in (no outbound access to maproulette.org's docs there) - it's the
standard REST shape for this API, but the very first --apply run against a
real challenge is worth watching closely (or trying on a small/test
challenge first). A dry run never touches the API's write endpoints, only
the read-only tasks listing.
"""

import argparse
import os
import sys
import time

import requests

LOW_DENSITY_PROPERTY = "_blockTriageLowDensity"
PAGE_SIZE = 500
MAX_ATTEMPTS = 3  # initial attempt + up to 2 retries
RETRY_BASE_DELAY_SECONDS = 0.6

# Overridable for a self-hosted MapRoulette instance (or for testing against
# a local mock server - see test_clear_low_density.py).
DEFAULT_API_BASE = os.environ.get("MAPROULETTE_API_BASE", "https://maproulette.org/api/v2")


class MapRouletteError(Exception):
    pass


def mr_request(session, api_base, method, path, api_key, json_body=None):
    url = api_base + path
    headers = {"apiKey": api_key, "Content-Type": "application/json", "From": "Block Triage - tronnalegacy@pm.me"}
    last_err = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            res = session.request(method, url, headers=headers, json=json_body, timeout=30)
        except requests.RequestException as err:
            last_err = err
            if attempt == MAX_ATTEMPTS:
                raise MapRouletteError(f"request failed: {err}") from err
            time.sleep(RETRY_BASE_DELAY_SECONDS * attempt)
            continue

        if res.ok:
            if res.status_code in (204, 304) or not res.text:
                return None
            return res.json()

        retryable = res.status_code == 429 or 500 <= res.status_code <= 599
        if retryable and attempt < MAX_ATTEMPTS:
            time.sleep(RETRY_BASE_DELAY_SECONDS * attempt)
            continue
        raise MapRouletteError(f"MapRoulette API {res.status_code}: {res.text or res.reason}")

    raise MapRouletteError(f"request failed: {last_err}")


def fetch_all_challenge_tasks(session, api_base, challenge_id, api_key):
    tasks = []
    page = 0
    while True:
        batch = mr_request(
            session, api_base, "GET", f"/challenge/{challenge_id}/tasks?limit={PAGE_SIZE}&page={page}", api_key
        )
        items = batch if isinstance(batch, list) else []
        tasks.extend(items)
        if len(items) < PAGE_SIZE:
            break
        page += 1
    return tasks


def task_has_low_density_flag(task):
    features = (task.get("geometries") or {}).get("features") or []
    return any((f.get("properties") or {}).get(LOW_DENSITY_PROPERTY) is True for f in features)


def clear_flag_on_task(session, api_base, task, api_key):
    updated = dict(task)
    updated["geometries"] = dict(task["geometries"])
    updated["geometries"]["features"] = []
    for feature in task["geometries"].get("features") or []:
        feature = dict(feature)
        if feature.get("properties"):
            properties = dict(feature["properties"])
            properties.pop(LOW_DENSITY_PROPERTY, None)
            feature["properties"] = properties
        updated["geometries"]["features"].append(feature)
    mr_request(session, api_base, "PUT", f"/task/{task['id']}", api_key, json_body=updated)


def parse_challenge_ids(values):
    challenge_ids = []
    for value in values or []:
        for part in value.split(","):
            part = part.strip()
            if part:
                challenge_ids.append(part)
    return challenge_ids


def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Clears the _blockTriageLowDensity property from every task in the given "
        "MapRoulette challenge(s). Without --apply, only reports what would change.",
    )
    parser.add_argument("--challenge", action="append", help="Challenge ID to clean up. Repeatable, or comma-separated.")
    parser.add_argument("--api-key", default=os.environ.get("MAPROULETTE_API_KEY"), help="MapRoulette API key (or set MAPROULETTE_API_KEY).")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE, help=argparse.SUPPRESS)
    parser.add_argument("--apply", action="store_true", help="Actually perform the updates (default: dry run).")
    return parser


def main(argv=None):
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    challenge_ids = parse_challenge_ids(args.challenge)
    if not challenge_ids:
        parser.error("at least one --challenge <id> is required")
    if not args.api_key:
        parser.error("an API key is required - pass --api-key or set MAPROULETTE_API_KEY")

    if not args.apply:
        print("Dry run - no changes will be made. Pass --apply to actually clear the flag.\n")

    session = requests.Session()
    total_scanned = 0
    total_flagged = 0
    total_updated = 0
    failures = []

    for challenge_id in challenge_ids:
        print(f"Challenge {challenge_id}:")
        tasks = fetch_all_challenge_tasks(session, args.api_base, challenge_id, args.api_key)
        total_scanned += len(tasks)
        print(f"  scanned {len(tasks)} task(s)")

        flagged = [t for t in tasks if task_has_low_density_flag(t)]
        total_flagged += len(flagged)
        print(f"  {len(flagged)} task(s) have the low-density flag set")

        for task in flagged:
            if not args.apply:
                print(f"  [dry run] would clear the flag on task {task['id']}")
                continue
            try:
                clear_flag_on_task(session, args.api_base, task, args.api_key)
                total_updated += 1
                print(f"  cleared the flag on task {task['id']}")
            except MapRouletteError as err:
                failures.append((challenge_id, task["id"], str(err)))
                print(f"  FAILED on task {task['id']}: {err}", file=sys.stderr)

    print("\n--- Summary ---")
    print(f"Scanned: {total_scanned}")
    print(f"Flagged: {total_flagged}")
    if args.apply:
        print(f"Updated: {total_updated}")
        print(f"Failed: {len(failures)}")
        if failures:
            print("\nFailed tasks (left unchanged - safe to re-run, already-cleared tasks are skipped next time):")
            for challenge_id, task_id, error in failures:
                print(f"  challenge {challenge_id} / task {task_id}: {error}")
    else:
        print("\nThis was a dry run - nothing was changed. Re-run with --apply to actually clear the flag.")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
