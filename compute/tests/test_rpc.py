"""针对真实 worker 子进程（``compute.tests._fake_worker``）的协议测试。"""
import json
import queue
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


class Worker:
    def __init__(self, module: str = "compute.tests._fake_worker", env: dict | None = None,
                 stderr=subprocess.PIPE):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", module],
            cwd=REPO,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
        )
        self.lines: "queue.Queue[str]" = queue.Queue()
        self.raw: list[bytes] = []
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            self.raw.append(line)
            self.lines.put(line.decode("utf-8"))

    def send(self, message: dict | str):
        data = message if isinstance(message, str) else json.dumps(message, ensure_ascii=False)
        self.proc.stdin.write(data.encode("utf-8") + b"\n")
        self.proc.stdin.flush()

    def request(self, rid, method, params=None):
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)

    def next(self, timeout=10) -> dict:
        # Bun 客户端里的 JSON.parse 是严格的：不允许 NaN/Infinity 记号。
        return json.loads(self.lines.get(timeout=timeout), parse_constant=_reject_constant)

    def until_response(self, rid, timeout=10) -> tuple[dict, list[dict]]:
        notes = []
        deadline = time.monotonic() + timeout
        while True:
            msg = self.next(max(0.1, deadline - time.monotonic()))
            if msg.get("id") == rid and "method" not in msg:
                return msg, notes
            notes.append(msg)

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(5)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if stream is not None:
                stream.close()


def _reject_constant(name):
    raise ValueError(f"non-JSON constant {name}")


class RpcProtocolTest(unittest.TestCase):
    def setUp(self):
        self.w = Worker()

    def tearDown(self):
        self.w.close()

    def test_unicode_round_trip(self):
        self.w.request(1, "echo", {"text": "销售额 ≥ 100 万"})
        resp, _ = self.w.until_response(1)
        self.assertEqual(resp["result"], {"text": "销售额 ≥ 100 万"})

    def test_language_follows_each_request_and_is_hidden_from_methods(self):
        # 线程池线程会复用：语言必须按请求重设，不能残留上一个请求的值。
        self.w.request(1, "greet", {"_lang": "zh", "x": 1})
        self.w.request(2, "greet", {"_lang": "en"})
        self.w.request(3, "greet", {})
        self.w.request(4, "greet", {"_lang": "fr"})
        results = {}
        for rid in (1, 2, 3, 4):
            resp, _ = self.w.until_response(rid)
            results[rid] = resp["result"]
        self.assertEqual(results[1], {"text": "你好", "params": {"x": 1}})
        self.assertEqual(results[2], {"text": "hello", "params": {}})
        self.assertEqual(results[3], {"text": "hello", "params": {}})
        self.assertEqual(results[4], {"text": "hello", "params": {}})

    def test_requests_run_concurrently_and_answer_out_of_order(self):
        self.w.request("slow", "sleep", {"seconds": 1.0})
        self.w.request("fast", "echo", {"x": 1})
        first = self.w.next()
        self.assertEqual(first["id"], "fast")
        second = self.w.next()
        self.assertEqual(second["id"], "slow")

    def test_cancel_stops_running_method(self):
        self.w.request(7, "loop")
        self.w.next()  # 第一条 progress 通知：方法已在运行
        self.w.send({"jsonrpc": "2.0", "method": "$/cancel", "params": {"id": 7}})
        resp, notes = self.w.until_response(7)
        self.assertEqual(resp["error"]["code"], -32800)
        self.assertTrue(all(n["method"] == "progress" and n["params"]["id"] == 7 for n in notes))

    def test_cancel_of_unknown_id_is_ignored(self):
        self.w.send({"jsonrpc": "2.0", "method": "$/cancel", "params": {"id": 999}})
        self.w.request(1, "echo", {})
        resp, _ = self.w.until_response(1)
        self.assertEqual(resp["result"], {})

    def test_error_codes(self):
        self.w.request(1, "app_error")
        self.w.request(2, "crash")
        self.w.request(3, "no_such_method")
        self.w.request(4, "echo", [1, 2])
        got = {}
        for _ in range(4):
            msg = self.w.next()
            got[msg["id"]] = msg["error"]
        self.assertEqual(got[1], {"code": -32000, "message": "bad table", "data": {"kind": "table_not_found"}})
        self.assertEqual(got[2]["code"], -32603)
        self.assertIn("KeyError", got[2]["message"])
        self.assertEqual(got[3]["code"], -32601)
        self.assertEqual(got[4]["code"], -32602)

    def test_malformed_input_does_not_kill_worker(self):
        self.w.send("{not json")
        self.assertEqual(self.w.next()["error"]["code"], -32700)
        self.w.send({"id": 5, "method": "echo"})  # 缺少 jsonrpc
        msg = self.w.next()
        self.assertEqual((msg["id"], msg["error"]["code"]), (5, -32600))
        self.w.send("[1,2]")
        self.assertEqual(self.w.next()["error"]["code"], -32600)
        self.w.request(6, "echo", {"alive": True})
        self.assertEqual(self.w.until_response(6)[0]["result"], {"alive": True})

    def test_duplicate_in_flight_id_rejected(self):
        self.w.request("dup", "sleep", {"seconds": 0.5})
        self.w.request("dup", "echo", {})
        first = self.w.next()
        self.assertEqual(first["error"]["code"], -32600)
        second = self.w.next()
        self.assertEqual(second["result"], {"slept": 0.5})
        # 应答之后再复用该 id 是可以的。
        self.w.request("dup", "echo", {"again": 1})
        self.assertEqual(self.w.until_response("dup")[0]["result"], {"again": 1})

    def test_stdout_writes_never_reach_protocol_stream(self):
        self.w.request(1, "noisy")
        resp, notes = self.w.until_response(1)
        self.assertEqual(resp["result"], {"ok": True})
        self.assertEqual(notes, [])
        self.w.request(2, "shutdown")
        self.w.until_response(2)
        self.w.proc.wait(5)
        for line in self.w.raw:
            json.loads(line)  # 协议流上的每一行都是 JSON
        stderr = self.w.proc.stderr.read().decode()
        for text in ("python print to stdout", "direct sys.stdout write", "raw fd 1 write"):
            self.assertIn(text, stderr)

    def test_non_finite_floats_become_null(self):
        self.w.request(1, "not_finite")
        resp, _ = self.w.until_response(1)
        self.assertEqual(resp["result"], {"nan": None, "inf": None, "np_nan": None, "nested": [1.5, None]})

    def test_event_notification_carries_request_id(self):
        self.w.request(3, "event")
        resp, notes = self.w.until_response(3)
        self.assertEqual(resp["result"], {"sent": True})
        self.assertEqual(notes, [{"jsonrpc": "2.0", "method": "event", "params": {"id": 3, "event": {"type": "chart", "html": "<div>图表</div>"}}}])

    def test_shutdown_waits_for_in_flight_requests(self):
        self.w.request("slow", "sleep", {"seconds": 0.5})
        self.w.request("bye", "shutdown")
        ids = [self.w.next()["id"], self.w.next()["id"]]
        self.assertEqual(sorted(ids, key=str), ["bye", "slow"])
        self.assertEqual(self.w.proc.wait(5), 0)

    def test_stdin_eof_exits_cleanly(self):
        self.w.proc.stdin.close()
        self.assertEqual(self.w.proc.wait(5), 0)


if __name__ == "__main__":
    unittest.main()
