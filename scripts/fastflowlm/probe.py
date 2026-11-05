"""Black-box tests against an actual patched FLM. No system setup or model downloads."""

import argparse
import contextlib
import hashlib
import http.client
import json
import os
import socket
import socketserver
import subprocess
import tempfile
import threading
import time
from pathlib import Path

LOCK = json.loads((Path(__file__).parent / "provenance.json").read_text())


class NetworkTrap(socketserver.BaseRequestHandler):
    def handle(self):
        self.server.attempts += 1
        self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")


def request(port, method, path, body=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=90)
    try:
        connection.request(method, path, None if body is None else json.dumps(body),
                           {"Content-Type": "application/json"})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def snapshot(root):
    result = {}
    for file in sorted(root.rglob("*")):
        if file.is_symlink():
            result[file.relative_to(root)] = ("symlink", os.readlink(file))
        elif file.is_file():
            digest = hashlib.sha256()
            with file.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            result[file.relative_to(root)] = ("file", digest.digest())
        else:
            result[file.relative_to(root)] = ("directory",)
    return result


def negative_cases(binary, work, env, trap_url):
    catalog = work / "catalog.json"
    model = work / "qwen"
    model.mkdir()
    info = work / "info.json"
    info.write_text("{}")
    env.update(FLM_CONFIG_PATH=str(catalog), FLM_MODELINFO_PATH=str(info), FLM_MODEL_PATH=str(work))
    entry = {"name": "qwen", "flm_min_version": "0.9.22", "url": trap_url, "file_url": trap_url,
             "files": ["config.json", "model.q4nx"]}
    cmd = [binary, "serve", "qwen3:0.6b", "--atomic-local-only"]

    def reject(detail=None):
        before = snapshot(work)
        result = subprocess.run(cmd, env=env, cwd=work, capture_output=True, text=True, timeout=30)
        errors = [json.loads(line) for line in result.stderr.splitlines() if line.startswith("{")]
        require(result.returncode != 0 and any(
            error.get("error") == "invalid_local_installation" and
            (detail is None or error.get("detail") == detail) for error in errors
        ), f"unexpected rejection: {result.returncode}: {result.stderr[-500:]}")
        require(snapshot(work) == before, "rejected operation changed local files")

    # A normal upstream catalog in cwd must not be used as fallback.
    (work / "model_list.json").write_text('{"model_path":".","models":{}}')
    reject()
    catalog.write_text(json.dumps({"model_path": ".", "models": {"qwen3": {"0.6b": entry}}}))
    (model / "config.json").write_text('{"flm_version":"0.9.22"}')
    reject("missing_local_file")
    (model / "model.q4nx").write_bytes(b"unchanged")
    (model / "config.json").write_text('{"flm_version":"0.9.1"}')
    reject("outdated_local_model")


def live_case(binary, work, env, args, trap_url):
    base = args.model_base.resolve(strict=True)
    catalog = json.loads(args.catalog.read_text())
    family, variant = args.checkpoint.split(":", 1)
    entry = catalog["models"][family][variant]
    # Redirect catalog sources on a disposable copy. Model files stay in place.
    entry.update(url=trap_url, file_url=trap_url, ms_url=trap_url)
    local_catalog = work / "live.json"
    local_catalog.write_text(json.dumps(catalog))
    env.update(FLM_CONFIG_PATH=str(local_catalog), FLM_MODELINFO_PATH=str(args.model_info.resolve(strict=True)),
               FLM_MODEL_PATH=str(base))
    model = (base / catalog["model_path"] / entry["name"]).resolve(strict=True)
    require(model.is_relative_to(base), "model outside base")
    # Vendor code opens <prefix>/xclbins/<model-dir>/<kernel>. A single
    # directory link in the session cache exposes the verified installer files.
    kernel_root = work / "cache"
    (kernel_root / "xclbins").mkdir(parents=True)
    kernel_link = kernel_root / "xclbins" / model.name
    if os.name == "nt":
        subprocess.run(["node", "-e", "require('node:fs').symlinkSync(process.argv[1], process.argv[2], 'junction')",
                        str(model), str(kernel_link)], check=True)
    else:
        kernel_link.symlink_to(model, target_is_directory=True)
    env["FLM_XCLBIN_PATH"] = str(kernel_root)
    before = snapshot(model)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with (work / "serve.log").open("w+") as log:
        process = subprocess.Popen([binary, "serve", args.checkpoint, "--atomic-local-only", "--port",
                                    str(port)], env=env, cwd=work, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    status, data = request(port, "GET", "/v1/models")
                except OSError:
                    time.sleep(0.25)
                    continue
                require(status == 200 and [r["id"] for r in data["data"]] == [args.checkpoint],
                        f"unexpected loaded model: {data}")
                break
            else:
                log.seek(0)
                raise RuntimeError("model did not become ready: " + log.read()[-1000:])
            require(request(port, "POST", "/api/pull", {"name": "missing"})[0] == 404,
                    "direct model pull accepted")
            chat = {
                "model": args.checkpoint, "messages": [{"role": "user", "content": "Say hello."}],
                "max_tokens": 32, "think": False, "stream": False}
            # Change only the disposable catalog, leaving the installed files untouched.
            for invalid_entry in ({"files": [*entry["files"], "absent-test-weight.q4nx"]},
                                  {"flm_min_version": "999.0.0"}):
                contents = json.loads(json.dumps(catalog))
                contents["models"][family][variant].update(invalid_entry)
                local_catalog.write_text(json.dumps(contents))
                status, reply = request(port, "POST", "/v1/chat/completions", chat)
                require(status == 409 and reply.get("error") == "invalid_local_installation",
                        f"inference accepted changed installation: {status} {reply}")
            local_catalog.write_text(json.dumps(catalog))
            print("passed: loaded checkpoint, direct pull rejected, missing/outdated requests rejected", flush=True)
            status, reply = request(port, "POST", "/v1/chat/completions", chat)
            if status != 200 or not reply.get("choices", [{}])[0].get("message", {}).get("content"):
                log.seek(0)
                raise RuntimeError(f"offline inference HTTP {status}: {reply!r}\n{log.read()[-4000:]}")
            answer = reply["choices"][0]["message"]["content"]
            require(isinstance(answer, str) and answer.strip(), "empty offline completion")
            print("offline completion:", repr(answer[:200]), flush=True)
        finally:
            process.kill()
            process.wait(timeout=15)
            require(before == snapshot(model), "inference changed the installed model")


def probe_environment(env):
    hidden_prefixes = ("FLM_", "HF_", "HUGGINGFACE", "HUGGING_FACE")
    return {k: v for k, v in env.items() if not k.upper().startswith(hidden_prefixes)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--catalog", type=Path)
    parser.add_argument("--model-base", type=Path)
    parser.add_argument("--model-info", type=Path)
    parser.add_argument("--checkpoint")
    args = parser.parse_args()
    live = (args.catalog, args.model_base, args.model_info, args.checkpoint)
    if any(live) and not all(live):
        parser.error("supply all four model arguments for the live test")
    binary = args.binary.resolve(strict=True)
    env = probe_environment(os.environ)
    with tempfile.TemporaryDirectory() as temp, socketserver.TCPServer(("127.0.0.1", 0), NetworkTrap) as trap:
        trap.attempts = 0
        thread = threading.Thread(target=trap.serve_forever, daemon=True)
        thread.start()
        with contextlib.ExitStack() as cleanup:
            cleanup.callback(trap.shutdown)
            url = f"http://127.0.0.1:{trap.server_address[1]}"
            for key in ("http_proxy", "https_proxy", "all_proxy"):
                env[key] = env[key.upper()] = url
            env["NO_PROXY"] = env["no_proxy"] = ""
            work = Path(temp)
            identity = json.loads(subprocess.check_output([binary, "atomic-capabilities", "--json"],
                                                         cwd=work, env=env, timeout=15))
            require(identity == {"upstream_commit": LOCK["commit"], "atomic_revision": LOCK["atomic_revision"],
                                 "local_only_protocol": 1}, "wrong build identity")
            negative_cases(binary, work, env, url)
            if all(live):
                live_case(binary, work, env, args, url)
            require(trap.attempts == 0, f"observed {trap.attempts} outbound connection attempts")
            print("passed: build identity, invalid config, missing/outdated, zero trap connections")
            if all(live):
                print("passed: loaded checkpoint, direct pull rejected, offline chat, missing/outdated requests rejected, model tree unchanged")


if __name__ == "__main__":
    main()
