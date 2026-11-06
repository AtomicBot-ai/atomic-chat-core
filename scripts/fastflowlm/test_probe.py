"""Environment passed to the real, independently packaged binary."""
import unittest

from probe import probe_environment


class ProbeEnvironmentTest(unittest.TestCase):
    def test_removes_model_hub_credentials_and_user_flm_overrides(self):
        keys = ("HF_TOKEN", "huggingface_hub_token", "HUGGING_FACE_HUB_TOKEN",
                "HUGGINGFACEHUB_API_TOKEN", "FLM_CONFIG_PATH")
        env = {"PATH": "/bin", "XILINX_XRT": "/bundle", **dict.fromkeys(keys, "fixture")}
        self.assertEqual(probe_environment(env), {"PATH": "/bin", "XILINX_XRT": "/bundle"})
