# Ubuntu 24.04 x64 is the oldest supported Linux userspace.
FROM ghcr.io/rocm/fastflowlm/build-environment@sha256:e0b27cf639e0cb4352d713241a41ef5680a59defadc131d377ddcfb652888e81
COPY provenance.json /opt/atomic-flm/
RUN python3 - <<'PY'
import hashlib, json, subprocess, tempfile
from pathlib import Path
from urllib.request import urlretrieve

for component in json.loads(Path("/opt/atomic-flm/provenance.json").read_text())["linux"]["rust_components"]:
    archive = Path("/tmp") / component["url"].split("/")[-1]
    urlretrieve(component["url"], archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != component["sha256"]:
        raise ValueError("Rust distribution checksum mismatch")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["tar", "xf", archive, "-C", tmp], check=True)
        installer = next(Path(tmp).glob("*/install.sh"))
        subprocess.run([installer, "--prefix=/opt/atomic-rust", "--disable-ldconfig"], check=True)
    archive.unlink()
PY
ENV PATH="/opt/atomic-rust/bin:${PATH}"
COPY Cargo.lock build.py local-only.patch /opt/atomic-flm/
ENTRYPOINT ["python3", "/opt/atomic-flm/build.py"]
