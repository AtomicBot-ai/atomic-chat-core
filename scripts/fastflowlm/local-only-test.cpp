// Native policy regression, compiled against the patched upstream include tree.
#include "atomic_local.hpp"
#include <fstream>
#include <iostream>

using namespace atomic_local;
using json = nlohmann::json;

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    if (version<4>("32.0.204.1") <= version<4>("32.0.203.304") ||
        version<4>("31.0.203.999") >= version<4>("32.0.203.304")) return 1;
    try { version<4>("32.0.203"); return 1; }
    catch (const std::runtime_error&) {}
    const fs::path root(argv[1]);
    const auto config = root / "selected.json";
    std::ofstream(config) << "{}";
    if (require_path(config.string().c_str(), false) != config) return 1;
    for (const auto& path : {std::string(), std::string("selected.json"), (root / "missing").string()}) {
        try { require_path(path.c_str(), false); return 1; }
        catch (const std::runtime_error&) {}
    }
    if (allow_route("POST", "/api/pull") || allow_route("POST", "/v1/embeddings") ||
        !allow_route("POST", "/v1/chat/completions") || !allow_route("GET", "/v1/models")) return 1;
    json chat = {{"model", "qwen3:0.6b"}, {"messages", {{{"role", "user"}, {"content", "Hello"}}}}};
    if (!allow_chat(chat, "qwen3:0.6b")) return 1;
    chat["model"] = "different";
    if (allow_chat(chat, "qwen3:0.6b")) return 1;
    chat["model"] = "qwen3:0.6b";
    chat["backend"] = "core";
    if (allow_chat(chat, "qwen3:0.6b")) return 1;
    chat.erase("backend");
    chat["messages"][0]["content"] = {{{"type", "image_url"}, {"image_url", {{"url", "https://invalid.example"}}}}};
    if (allow_chat(chat, "qwen3:0.6b")) return 1;
    const auto installation = root / "fixture";
    fs::create_directories(installation);
    const auto catalog = root / "model_list.json";
    json entry = {{"name", "fixture"}, {"flm_min_version", "0.9.22"},
                  {"files", {"config.json", "model.q4nx"}}};
    json models = {{"model_path", "."}, {"models", {{"qwen3", {{"0.6b", entry}}}}}};
    std::ofstream(catalog) << models;
    auto rejected = [&](const std::string& expected) {
        try { check_install(catalog, root, "qwen3:0.6b", "1.0.11"); }
        catch (const std::exception& e) { return expected == e.what(); }
        return false;
    };
    std::ofstream(installation / "config.json") << R"({"flm_version":"0.9.22"})";
    if (!rejected("missing_local_file") || fs::exists(installation / "model.q4nx")) return 1;
    std::ofstream(installation / "model.q4nx") << "fixture";
    const auto kernels = root / "cache" / "xclbins";
    fs::create_directories(kernels);
    fs::create_directory_symlink(installation, kernels / "fixture");
    auto check_session = [&]() {
        check_session_install(catalog, root, "qwen3:0.6b", "1.0.11", kernels.parent_path());
    };
    check_session();
    // A changed link after readiness must fail a new request.
    fs::remove(kernels / "fixture");
    fs::create_directory_symlink(root, kernels / "fixture");
    try { check_session(); return 1; }
    catch (const std::runtime_error& e) {
        if (std::string(e.what()) != "invalid_local_kernel_directory") return 1;
    }
    std::ofstream(installation / "config.json") << R"({"flm_version":"0.9.9"})";
    if (!rejected("outdated_local_model") || fs::file_size(installation / "model.q4nx") != 7) return 1;
    models["models"]["qwen3"]["0.6b"]["files"] = {"../selected.json"};
    std::ofstream(catalog) << models;
    if (!rejected("invalid_local_path")) return 1;
    std::cout << "local-only configuration, routes and requests: passed\n";
}
