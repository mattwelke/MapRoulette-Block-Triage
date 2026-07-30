"""Tests clear_low_density.py against a local mock HTTP server standing in
for the MapRoulette API (via the --api-base / MAPROULETTE_API_BASE override
- see that script for why it exists). Run with:

    python3 -m unittest scripts/test_clear_low_density.py -v

(from a venv with requirements.txt installed - see clear_low_density.py's
own docstring for setup).
"""

import json
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

LOW_DENSITY_PROPERTY = "_blockTriageLowDensity"
SCRIPT_PATH = __file__.replace("test_clear_low_density.py", "clear_low_density.py")


def make_task(task_id, low_density):
    properties = {"other": "keep-me"}
    if low_density:
        properties[LOW_DENSITY_PROPERTY] = True
    return {
        "id": task_id,
        "name": f"task-{task_id}",
        "parent": 5001,
        "status": 0,
        "geometries": {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": properties,
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[-79.7, 43.4], [-79.69, 43.4], [-79.69, 43.41], [-79.7, 43.4]]],
                    },
                }
            ],
        },
    }


class MockMapRouletteServer:
    """A local HTTP server mocking GET /challenge/{id}/tasks and PUT /task/{id}.

    `tasks_by_challenge` maps challenge id (str) -> list of task dicts.
    `put_responses` optionally maps task id (str) -> (status_code, body) to
    override the default 200 OK, for exercising failure handling.
    Every accepted PUT body is recorded in `put_requests`.
    """

    def __init__(self, tasks_by_challenge, put_responses=None):
        self.tasks_by_challenge = tasks_by_challenge
        self.put_responses = put_responses or {}
        self.put_requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass  # keep test output quiet

            def do_GET(self):
                parts = self.path.split("?")[0].strip("/").split("/")
                if len(parts) == 5 and parts[:3] == ["api", "v2", "challenge"] and parts[4] == "tasks":
                    challenge_id = parts[3]
                    tasks = outer.tasks_by_challenge.get(challenge_id, [])
                    body = json.dumps(tasks).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(404)
                self.end_headers()

            def do_PUT(self):
                parts = self.path.strip("/").split("/")
                task_id = parts[3] if len(parts) == 4 else None
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                status, resp_body = outer.put_responses.get(task_id, (200, "null"))
                if status == 200:
                    outer.put_requests.append((task_id, json.loads(body)))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(resp_body.encode() if isinstance(resp_body, str) else resp_body)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def api_base(self):
        return f"http://127.0.0.1:{self.port}/api/v2"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def run_script(args, api_base, api_key="fake-test-key"):
    cmd = [sys.executable, SCRIPT_PATH, "--api-base", api_base] + args
    env_args = cmd if api_key is None else cmd + ["--api-key", api_key]
    return subprocess.run(env_args, capture_output=True, text=True)


class ClearLowDensityTests(unittest.TestCase):
    def test_dry_run_reports_flagged_tasks_without_calling_put(self):
        mock = MockMapRouletteServer({"5001": [make_task(1, True), make_task(2, False), make_task(3, True)]})
        try:
            result = run_script(["--challenge", "5001"], mock.api_base)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("scanned 3 task(s)", result.stdout)
            self.assertIn("2 task(s) have the low-density flag set", result.stdout)
            self.assertIn("would clear the flag on task 1", result.stdout)
            self.assertIn("would clear the flag on task 3", result.stdout)
            self.assertEqual(mock.put_requests, [])
        finally:
            mock.close()

    def test_apply_clears_only_flagged_tasks_leaving_everything_else_untouched(self):
        mock = MockMapRouletteServer({"5001": [make_task(1, True), make_task(2, False), make_task(3, True)]})
        try:
            result = run_script(["--challenge", "5001", "--apply"], mock.api_base)
            self.assertEqual(result.returncode, 0, result.stderr)
            put_ids = sorted(task_id for task_id, _ in mock.put_requests)
            self.assertEqual(put_ids, ["1", "3"])
            for task_id, body in mock.put_requests:
                props = body["geometries"]["features"][0]["properties"]
                self.assertNotIn(LOW_DENSITY_PROPERTY, props)
                self.assertEqual(props["other"], "keep-me")
                self.assertEqual(body["status"], 0)
                self.assertEqual(body["name"], f"task-{task_id}")
            self.assertIn("Updated: 2", result.stdout)
            self.assertIn("Failed: 0", result.stdout)
        finally:
            mock.close()

    def test_sweeps_multiple_challenges_given_as_repeated_and_comma_separated_flags(self):
        mock = MockMapRouletteServer(
            {"5001": [make_task(1, True)], "5002": [make_task(2, True)], "5003": [make_task(3, True)]}
        )
        try:
            result = run_script(["--challenge", "5001,5002", "--challenge", "5003", "--apply"], mock.api_base)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(mock.put_requests), 3)
            self.assertIn("Scanned: 3", result.stdout)
        finally:
            mock.close()

    def test_refuses_to_run_without_a_challenge_id_or_an_api_key(self):
        mock = MockMapRouletteServer({})
        try:
            no_challenge = run_script([], mock.api_base)
            self.assertNotEqual(no_challenge.returncode, 0)
            self.assertIn("--challenge", no_challenge.stderr)

            no_key = run_script(["--challenge", "5001"], mock.api_base, api_key=None)
            self.assertNotEqual(no_key.returncode, 0)
            self.assertIn("API key", no_key.stderr)
        finally:
            mock.close()

    def test_a_failed_put_is_reported_but_does_not_stop_the_rest_of_the_run(self):
        mock = MockMapRouletteServer(
            {"5001": [make_task(1, True), make_task(2, True)]},
            put_responses={"1": (400, json.dumps({"status": "Error", "message": "bad request"}))},
        )
        try:
            result = run_script(["--challenge", "5001", "--apply"], mock.api_base)
            self.assertEqual(result.returncode, 1)
            self.assertEqual([task_id for task_id, _ in mock.put_requests], ["2"])
            self.assertIn("Updated: 1", result.stdout)
            self.assertIn("Failed: 1", result.stdout)
            self.assertIn("FAILED on task 1", result.stderr)
        finally:
            mock.close()


if __name__ == "__main__":
    unittest.main()
