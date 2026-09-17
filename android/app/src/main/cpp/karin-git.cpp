// Android-host libgit2 bridge. No shell commands or proot processes are used here.
#include <jni.h>
#include <git2.h>
#include <git2/sys/errors.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include <ctime>

namespace fs = std::filesystem;
namespace {
template<class T, void (*Free)(T*)> using Handle = std::unique_ptr<T, decltype(Free)>;
using Repo = Handle<git_repository, git_repository_free>;
using Remote = Handle<git_remote, git_remote_free>;
using Object = Handle<git_object, git_object_free>;
using Reference = Handle<git_reference, git_reference_free>;
std::mutex initMutex;
bool initialized = false;
// libgit2 does not permit simultaneous writes to the same repository. Reads also
// take this lock so history/status cannot observe a partially checked-out tree.
std::mutex repositoryMutex;
std::mutex operationsMutex;
std::unordered_map<std::string, std::shared_ptr<std::atomic_bool>> operations;
std::atomic_uint64_t nextStaging{0};

void check(int result) {
  if (result >= 0) return;
  const git_error* error = git_error_last();
  throw std::runtime_error(error && error->message ? error->message : "libgit2 operation failed");
}

// JNI's NewStringUTF uses modified UTF-8, which corrupts non-BMP commit messages.
jstring javaString(JNIEnv* env, const std::string& value) {
  auto bytes = env->NewByteArray(static_cast<jsize>(value.size()));
  env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(value.size()), reinterpret_cast<const jbyte*>(value.data()));
  auto type = env->FindClass("java/lang/String");
  auto encoding = env->NewStringUTF("UTF-8");
  auto result = static_cast<jstring>(env->NewObject(type, env->GetMethodID(type, "<init>", "([BLjava/lang/String;)V"), bytes, encoding));
  env->DeleteLocalRef(bytes); env->DeleteLocalRef(type); env->DeleteLocalRef(encoding);
  return result;
}
std::string nativeString(JNIEnv* env, jstring value) {
  if (!value) return {};
  auto type = env->FindClass("java/lang/String");
  auto encoding = env->NewStringUTF("UTF-8");
  auto bytes = static_cast<jbyteArray>(env->CallObjectMethod(value, env->GetMethodID(type, "getBytes", "(Ljava/lang/String;)[B"), encoding));
  if (env->ExceptionCheck() || !bytes) throw std::runtime_error("Invalid Java string");
  std::string result(static_cast<size_t>(env->GetArrayLength(bytes)), '\0');
  env->GetByteArrayRegion(bytes, 0, static_cast<jsize>(result.size()), reinterpret_cast<jbyte*>(result.data()));
  env->DeleteLocalRef(bytes); env->DeleteLocalRef(type); env->DeleteLocalRef(encoding);
  if (result.find('\0') != std::string::npos) throw std::runtime_error("NUL is not allowed in Git arguments");
  return result;
}
std::string json(const std::string& value) {
  std::string out = "\"";
  const char* digits = "0123456789abcdef";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
    else if (c < 32) { out += "\\u00"; out += digits[c >> 4]; out += digits[c & 15]; }
    else out += static_cast<char>(c);
  }
  return out + '"';
}
void fail(JNIEnv* env, const std::exception& error) {
  if (env->ExceptionCheck()) return;
  auto type = env->FindClass("java/lang/IllegalStateException");
  auto message = javaString(env, error.what());
  auto exception = static_cast<jthrowable>(env->NewObject(type, env->GetMethodID(type, "<init>", "(Ljava/lang/String;)V"), message));
  env->Throw(exception);
  env->DeleteLocalRef(exception); env->DeleteLocalRef(message); env->DeleteLocalRef(type);
}
struct Options {
  JNIEnv* env;
  jclass type;
  jobject value;
  Options(JNIEnv* e, jstring source) : env(e), type(e->FindClass("org/json/JSONObject")) {
    value = env->NewObject(type, env->GetMethodID(type, "<init>", "(Ljava/lang/String;)V"), source);
    if (env->ExceptionCheck()) throw std::runtime_error("Invalid Git options JSON");
  }
  ~Options() { env->DeleteLocalRef(value); env->DeleteLocalRef(type); }
  std::string string(const char* key) {
    auto name = env->NewStringUTF(key);
    auto result = static_cast<jstring>(env->CallObjectMethod(value, env->GetMethodID(type, "optString", "(Ljava/lang/String;)Ljava/lang/String;"), name));
    auto text = nativeString(env, result);
    env->DeleteLocalRef(name); env->DeleteLocalRef(result);
    return text;
  }
  int number(const char* key, int fallback) {
    auto name = env->NewStringUTF(key);
    int result = env->CallIntMethod(value, env->GetMethodID(type, "optInt", "(Ljava/lang/String;I)I"), name, fallback);
    env->DeleteLocalRef(name); return result;
  }
  bool boolean(const char* key) {
    auto name = env->NewStringUTF(key);
    bool result = env->CallBooleanMethod(value, env->GetMethodID(type, "optBoolean", "(Ljava/lang/String;Z)Z"), name, JNI_FALSE);
    env->DeleteLocalRef(name); return result;
  }
};

struct Operation {
  JNIEnv* env;
  jobject callback;
  jmethodID onProgress = nullptr, isCancelled = nullptr;
  std::string id;
  std::shared_ptr<std::atomic_bool> cancelled = std::make_shared<std::atomic_bool>(false);
  std::chrono::steady_clock::time_point lastProgress{};
  Operation(JNIEnv* e, jobject cb, std::string operationId) : env(e), callback(cb), id(std::move(operationId)) {
    if (callback) {
      auto type = env->GetObjectClass(callback);
      onProgress = env->GetMethodID(type, "onProgress", "(Ljava/lang/String;)V");
      isCancelled = env->GetMethodID(type, "isCancelled", "()Z");
      env->DeleteLocalRef(type);
    }
    if (!id.empty()) {
      std::lock_guard<std::mutex> lock(operationsMutex);
      if (!operations.emplace(id, cancelled).second) throw std::runtime_error("Duplicate Git operation id");
    }
  }
  ~Operation() {
    if (!id.empty()) { std::lock_guard<std::mutex> lock(operationsMutex); operations.erase(id); }
  }
  bool stopped() {
    if (cancelled->load()) return true;
    if (callback && env->CallBooleanMethod(callback, isCancelled)) return true;
    return env->ExceptionCheck();
  }
  void ensureRunning() { if (stopped()) throw std::runtime_error("Git 操作已终止"); }
  int poll() {
    if (!stopped()) return 0;
    giterr_set_str(GIT_ERROR_CALLBACK, "Git 操作已终止"); return GIT_EUSER;
  }
  void progress(const std::string& message, bool throttle = false) {
    if (!callback || env->ExceptionCheck()) return;
    auto now = std::chrono::steady_clock::now();
    if (throttle && now - lastProgress < std::chrono::milliseconds(200)) return;
    lastProgress = now;
    auto text = javaString(env, message);
    env->CallVoidMethod(callback, onProgress, text);
    env->DeleteLocalRef(text);
  }
};
int transfer(const git_indexer_progress* p, void* payload) {
  auto& op = *static_cast<Operation*>(payload);
  if (op.poll()) return GIT_EUSER;
  op.progress("接收对象 " + std::to_string(p->received_objects) + "/" + std::to_string(p->total_objects) +
    " · " + std::to_string(p->received_bytes / 1024) + " KiB", true);
  return op.poll();
}
int sideband(const char* text, int length, void* payload) {
  auto& op = *static_cast<Operation*>(payload);
  if (length > 0) op.progress(std::string(text, static_cast<size_t>(length)), true);
  return op.poll();
}
int checkoutNotify(git_checkout_notify_t, const char*, const git_diff_file*, const git_diff_file*, const git_diff_file*, void* payload) {
  return static_cast<Operation*>(payload)->poll();
}
void checkoutProgress(const char*, size_t done, size_t total, void* payload) {
  static_cast<Operation*>(payload)->progress("检出文件 " + std::to_string(done) + "/" + std::to_string(total), true);
}
git_checkout_options checkoutOptions(Operation* op, unsigned int strategy) {
  git_checkout_options options{};
  check(git_checkout_options_init(&options, GIT_CHECKOUT_OPTIONS_VERSION));
  options.checkout_strategy = strategy;
  if (op) {
    options.notify_flags = GIT_CHECKOUT_NOTIFY_ALL;
    options.notify_cb = checkoutNotify; options.notify_payload = op;
    options.progress_cb = checkoutProgress; options.progress_payload = op;
  }
  return options;
}
git_fetch_options fetchOptions(Operation& op, int depth, bool prune) {
  git_fetch_options options{};
  check(git_fetch_options_init(&options, GIT_FETCH_OPTIONS_VERSION));
  options.depth = depth;
  options.prune = prune ? GIT_FETCH_PRUNE : GIT_FETCH_NO_PRUNE;
  options.callbacks.payload = &op;
  options.callbacks.transfer_progress = transfer;
  options.callbacks.sideband_progress = sideband;
  // Keep libgit2's default certificate and hostname verification enabled.
  return options;
}
void validateUrl(const std::string& url) {
  if (url.empty() || url.find_first_of("\r\n") != std::string::npos) throw std::runtime_error("无效的 Git 仓库地址");
  if (url.rfind("https://", 0) != 0 && url.rfind("http://", 0) != 0 && url.rfind("git://", 0) != 0 &&
      url.rfind("ssh://", 0) != 0 && url.rfind("git@", 0) != 0) throw std::runtime_error("Git 地址必须使用 HTTP(S)、git 或 SSH 协议");
  if ((url.rfind("ssh://", 0) == 0 || url.rfind("git@", 0) == 0) && !(git_libgit2_features() & GIT_FEATURE_SSH))
    throw std::runtime_error("当前 libgit2 未启用 SSH，请使用 HTTPS 仓库地址");
}
bool within(const fs::path& path, const fs::path& root) {
  auto child = path.lexically_normal(); auto base = root.lexically_normal();
  auto p = child.begin();
  for (auto r = base.begin(); r != base.end(); ++r, ++p) if (p == child.end() || *p != *r) return false;
  return true;
}
bool entryExists(const fs::path& path) {
  std::error_code error;
  const auto status = fs::symlink_status(path, error);
  if (error == std::errc::no_such_file_or_directory || error == std::errc::not_a_directory) return false;
  if (error) throw fs::filesystem_error("Cannot inspect Git path", path, error);
  return status.type() != fs::file_type::not_found;
}
// Opening must never search upward, follow an external gitdir/worktree, or use
// alternate object directories outside the plugin.
Repo openRepository(const fs::path& path) {
  if (!entryExists(path / ".git")) throw std::runtime_error("插件目录不是 Git 仓库（缺少 .git）");
  git_repository* raw = nullptr;
  check(git_repository_open_ext(&raw, path.c_str(), GIT_REPOSITORY_OPEN_NO_SEARCH, nullptr));
  Repo repo(raw, git_repository_free);
  auto root = fs::canonical(path);
  if (git_repository_is_bare(repo.get()) || !git_repository_workdir(repo.get()) || fs::canonical(git_repository_workdir(repo.get())) != root)
    throw std::runtime_error("Git worktree 必须位于当前插件目录");
  auto gitdir = fs::canonical(git_repository_path(repo.get()));
  auto common = fs::canonical(git_repository_commondir(repo.get()));
  if (!within(gitdir, root) || !within(common, root)) throw std::runtime_error("Git 元数据指向插件目录外部");
  for (auto& entry : fs::recursive_directory_iterator(gitdir)) {
    if (entry.is_symlink()) throw std::runtime_error("Git 元数据中不允许符号链接");
  }
  if (entryExists(common / "objects/info/alternates") || entryExists(common / "objects/info/http-alternates"))
    throw std::runtime_error("不支持包含外部 objects alternates 的仓库");
  return repo;
}
std::string oidString(const git_oid* oid) { char text[GIT_OID_HEXSZ + 1]; git_oid_tostr(text, sizeof(text), oid); return text; }
std::string currentHead(git_repository* repo) {
  git_oid oid{}; int result = git_reference_name_to_id(&oid, repo, "HEAD");
  if (result == GIT_EUNBORNBRANCH || result == GIT_ENOTFOUND) return {};
  check(result); return oidString(&oid);
}
std::string remoteUrl(git_repository* repo) {
  git_remote* raw = nullptr; int result = git_remote_lookup(&raw, repo, "origin");
  if (result == GIT_ENOTFOUND) return {};
  check(result); Remote remote(raw, git_remote_free);
  const char* url = git_remote_url(remote.get()); return url ? url : "";
}
void setRemote(git_repository* repo, const std::string& url) {
  validateUrl(url);
  git_remote* raw = nullptr; int result = git_remote_lookup(&raw, repo, "origin");
  if (result == GIT_ENOTFOUND) { check(git_remote_create(&raw, repo, "origin", url.c_str())); git_remote_free(raw); }
  else { check(result); git_remote_free(raw); check(git_remote_set_url(repo, "origin", url.c_str())); }
}
std::string trackedStatus(git_repository* repo, bool includeUntracked) {
  git_status_options options{};
  check(git_status_options_init(&options, GIT_STATUS_OPTIONS_VERSION));
  options.show = GIT_STATUS_SHOW_INDEX_AND_WORKDIR;
  options.flags = GIT_STATUS_OPT_RENAMES_HEAD_TO_INDEX | GIT_STATUS_OPT_RENAMES_INDEX_TO_WORKDIR;
  if (includeUntracked) options.flags |= GIT_STATUS_OPT_INCLUDE_UNTRACKED | GIT_STATUS_OPT_RECURSE_UNTRACKED_DIRS;
  git_status_list* raw = nullptr; check(git_status_list_new(&raw, repo, &options));
  Handle<git_status_list, git_status_list_free> list(raw, git_status_list_free);
  std::string output;
  auto code = [](unsigned flags, bool index) -> char {
    if (flags & GIT_STATUS_CONFLICTED) return 'U';
    if (flags & (index ? GIT_STATUS_INDEX_NEW : GIT_STATUS_WT_NEW)) return index ? 'A' : '?';
    if (flags & (index ? GIT_STATUS_INDEX_DELETED : GIT_STATUS_WT_DELETED)) return 'D';
    if (flags & (index ? GIT_STATUS_INDEX_RENAMED : GIT_STATUS_WT_RENAMED)) return 'R';
    if (flags & (index ? GIT_STATUS_INDEX_TYPECHANGE : GIT_STATUS_WT_TYPECHANGE)) return 'T';
    if (flags & (index ? GIT_STATUS_INDEX_MODIFIED : GIT_STATUS_WT_MODIFIED)) return 'M';
    return ' ';
  };
  for (size_t i = 0; i < git_status_list_entrycount(list.get()); ++i) {
    const auto* entry = git_status_byindex(list.get(), i);
    if (!entry || entry->status == GIT_STATUS_CURRENT || entry->status == GIT_STATUS_IGNORED) continue;
    const auto* delta = entry->index_to_workdir ? entry->index_to_workdir : entry->head_to_index;
    const char* path = delta ? (delta->new_file.path ? delta->new_file.path : delta->old_file.path) : "";
    output += code(entry->status, true); output += code(entry->status, false); output += ' '; output += path ? path : ""; output += '\n';
  }
  return output;
}
void checkoutCommit(git_repository* repo, const std::string& hash, Operation& op, bool detached, bool force) {
  const bool dirty = !trackedStatus(repo, false).empty();
  if (!force && dirty) throw std::runtime_error("插件目录有未提交的改动，请先提交或撤销后再切换");
  git_oid oid{}; check(git_oid_fromstr(&oid, hash.c_str()));
  git_object* raw = nullptr; check(git_object_lookup(&raw, repo, &oid, GIT_OBJECT_COMMIT));
  Object target(raw, git_object_free);
  op.ensureRunning();
  const std::string before = currentHead(repo);
  git_reference* headRaw = nullptr; check(git_repository_head(&headRaw, repo));
  Reference head(headRaw, git_reference_free);
  const bool wasDetached = git_repository_head_detached(repo) == 1;
  const std::string oldBranch = git_reference_name(head.get());
  bool stashed = false;
  // A confirmed overwrite may discard tracked edits, but a failed/cancelled
  // overwrite must restore them, including the index's staged state.
  if (force && dirty) {
    git_signature* signatureRaw = nullptr; check(git_signature_now(&signatureRaw, "Karin App", "karin-app@localhost"));
    Handle<git_signature, git_signature_free> signature(signatureRaw, git_signature_free);
    git_oid stash{}; check(git_stash_save(&stash, repo, signature.get(), "Karin App: temporary overwrite backup", GIT_STASH_DEFAULT));
    stashed = true;
  }
  auto options = checkoutOptions(&op, force ? GIT_CHECKOUT_FORCE : GIT_CHECKOUT_SAFE);
  // libgit2 cannot abort from its void progress callback while writing files.
  // Check again before changing HEAD, and restore files/index if interrupted.
  try {
    op.ensureRunning();
    if (detached) {
      check(git_checkout_tree(repo, target.get(), &options));
      op.ensureRunning();
      check(git_repository_set_head_detached(repo, &oid));
    } else {
      check(git_reset(repo, target.get(), GIT_RESET_HARD, &options));
      op.ensureRunning();
    }
  } catch (...) {
    const auto originalError = std::current_exception();
    if (!before.empty()) {
      git_oid oldOid{}; git_object* oldRaw = nullptr;
      check(git_oid_fromstr(&oldOid, before.c_str())); check(git_object_lookup(&oldRaw, repo, &oldOid, GIT_OBJECT_COMMIT));
      Object old(oldRaw, git_object_free); auto rollback = checkoutOptions(nullptr, GIT_CHECKOUT_FORCE);
      check(git_reset(repo, old.get(), GIT_RESET_HARD, &rollback));
      if (wasDetached) check(git_repository_set_head_detached(repo, &oldOid));
      else check(git_repository_set_head(repo, oldBranch.c_str()));
    }
    if (stashed) {
      git_stash_apply_options restore{}; check(git_stash_apply_options_init(&restore, GIT_STASH_APPLY_OPTIONS_VERSION));
      restore.flags = GIT_STASH_APPLY_REINSTATE_INDEX;
      check(git_stash_pop(repo, 0, &restore));
    }
    std::rethrow_exception(originalError);
  }
  if (stashed) check(git_stash_drop(repo, 0));
}
// Stage a clone beside the target, then rename on the same filesystem. Failed
// downloads/checkouts leave the previous plugin intact, including local files.
void cloneRepository(const fs::path& path, Options& args, Operation& op, bool replace, bool restore) {
  const auto url = args.string("url"); validateUrl(url);
  const auto branch = args.string("branch");
  if (fs::is_symlink(fs::symlink_status(path))) throw std::runtime_error("Git 目标目录不能是符号链接");
  if (entryExists(path) && (!fs::is_directory(path) || !fs::is_empty(path)) && !replace) throw std::runtime_error("目标目录已存在，请确认覆盖后重试");
  fs::create_directories(path.parent_path());
  const auto suffix = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-" + std::to_string(++nextStaging);
  const auto staging = path.parent_path() / (".karin-git-stage-" + suffix);
  const auto backup = path.parent_path() / (".karin-git-backup-" + suffix);
  bool backedUp = false, installed = false;
  try {
    op.ensureRunning(); op.progress("正在克隆 Git 仓库…");
    git_clone_options options{};
    check(git_clone_options_init(&options, GIT_CLONE_OPTIONS_VERSION));
    options.fetch_opts = fetchOptions(op, restore ? 0 : args.number("depth", 1), false);
    options.checkout_opts = checkoutOptions(&op, GIT_CHECKOUT_SAFE);
    options.local = GIT_CLONE_NO_LOCAL;
    options.checkout_branch = branch.empty() ? nullptr : branch.c_str();
    git_repository* raw = nullptr; check(git_clone(&raw, url.c_str(), staging.c_str(), &options));
    Repo repo(raw, git_repository_free);
    if (restore) checkoutCommit(repo.get(), args.string("commit"), op, true, false);
    repo.reset(); op.ensureRunning();
    if (entryExists(path)) { fs::rename(path, backup); backedUp = true; }
    fs::rename(staging, path); installed = true;
    if (backedUp) { std::error_code ignored; fs::remove_all(backup, ignored); }
    op.progress("Git 仓库已就绪");
  } catch (...) {
    std::error_code ignored;
    fs::remove_all(staging, ignored);
    if (backedUp && !installed) fs::rename(backup, path, ignored);
    throw;
  }
}
void fetchRepository(git_repository* repo, Operation& op, bool unshallow, bool prune, const std::string& branch = {}, bool update = false) {
  auto url = remoteUrl(repo); validateUrl(url);
  git_remote* raw = nullptr; check(git_remote_lookup(&raw, repo, "origin")); Remote remote(raw, git_remote_free);
  auto options = fetchOptions(op, unshallow && git_repository_is_shallow(repo) ? GIT_FETCH_DEPTH_UNSHALLOW : update ? 1 : 0, prune);
  std::string ref = branch.empty() ? "HEAD" : branch;
  // A single advertised ref fills FETCH_HEAD without moving a local branch.
  char* refText = ref.data(); git_strarray refs{&refText, 1};
  op.ensureRunning(); op.progress("正在获取远程提交…");
  check(git_remote_fetch(remote.get(), update ? &refs : nullptr, &options, nullptr));
  op.ensureRunning();
}
std::string readLog(git_repository* repo, int limit) {
  git_revwalk* raw = nullptr; check(git_revwalk_new(&raw, repo));
  Handle<git_revwalk, git_revwalk_free> walk(raw, git_revwalk_free);
  git_revwalk_sorting(walk.get(), GIT_SORT_TOPOLOGICAL | GIT_SORT_TIME);
  if (currentHead(repo).empty()) return "[]";
  check(git_revwalk_push_head(walk.get()));
  std::string result = "["; git_oid oid{}; int status = 0;
  for (int i = 0; i < limit && (status = git_revwalk_next(&oid, walk.get())) == 0; ++i) {
    git_commit* commitRaw = nullptr; check(git_commit_lookup(&commitRaw, repo, &oid));
    Handle<git_commit, git_commit_free> commit(commitRaw, git_commit_free);
    const auto* author = git_commit_author(commit.get());
    if (!author) throw std::runtime_error("Git commit has no author");
    auto time = static_cast<time_t>(author->when.time); struct tm local{}; localtime_r(&time, &local);
    char date[40]{}; strftime(date, sizeof(date), "%Y-%m-%d %H:%M", &local);
    const char* subject = git_commit_summary(commit.get());
    if (i) result += ',';
    result += "{\"hash\":" + json(oidString(&oid)) + ",\"subject\":" + json(subject ? subject : "") +
      ",\"author\":" + json(author->name ? author->name : "") + ",\"date\":" + json(date) + "}";
  }
  if (status != GIT_ITEROVER) check(status);
  return result + ']';
}
std::string listRepositories(const fs::path& root) {
  const auto base = root / "root/karin/plugins";
  if (!fs::is_directory(base)) return "[]";
  std::vector<fs::path> candidates;
  for (const auto& entry : fs::directory_iterator(base)) {
    if (entry.is_symlink() || !entry.is_directory()) continue;
    auto name = entry.path().filename().string();
    if (name.empty() || name[0] == '.' || name == "karin-plugin-example") continue;
    if (name[0] != '@') candidates.push_back(entry.path());
    else for (const auto& child : fs::directory_iterator(entry.path())) if (!child.is_symlink() && child.is_directory()) candidates.push_back(child.path());
  }
  std::string result = "["; bool comma = false;
  for (const auto& candidate : candidates) {
    try {
      auto repo = openRepository(candidate);
      const auto name = candidate.lexically_relative(base).generic_string();
      if (comma) result += ','; comma = true;
      result += "{\"name\":" + json(name) + ",\"path\":" + json("/root/karin/plugins/" + name) + ",\"remote\":" + json(remoteUrl(repo.get())) + "}";
    } catch (const std::exception&) { /* A malformed/local directory is not a Git repository. */ }
  }
  return result + ']';
}
std::string execute(const std::string& action, const fs::path& path, Options& args, Operation& op) {
  // Waiting callers can cancel before any mutation begins.
  std::unique_lock<std::mutex> lock(repositoryMutex);
  op.ensureRunning();
  if (action == "pathState") {
    const auto state = !entryExists(path) ? "missing" : fs::is_directory(path) && fs::is_empty(path) ? "empty" : "occupied";
    return "{\"state\":" + json(state) + "}";
  }
  if (action == "listRepositories") return listRepositories(path);
  if (action == "clone" || action == "restore") { cloneRepository(path, args, op, action == "restore", action == "restore"); return "{\"ok\":true}"; }
  if (action == "isRepository") {
    if (!entryExists(path / ".git")) return "{\"isRepository\":false}";
    auto repo = openRepository(path); return "{\"isRepository\":true}";
  }
  if (action == "update" && !entryExists(path / ".git")) { cloneRepository(path, args, op, true, false); return "{\"ok\":true}"; }
  auto repo = openRepository(path);
  if (action == "isShallow") return std::string("{\"shallow\":") + (git_repository_is_shallow(repo.get()) ? "true}" : "false}");
  if (action == "head") return "{\"head\":" + json(currentHead(repo.get())) + "}";
  if (action == "remoteUrl") return "{\"url\":" + json(remoteUrl(repo.get())) + "}";
  if (action == "setRemoteUrl") setRemote(repo.get(), args.string("url"));
  else if (action == "status") { auto output = trackedStatus(repo.get(), args.boolean("includeUntracked")); return "{\"dirty\":" + std::string(output.empty() ? "false" : "true") + ",\"output\":" + json(output) + "}"; }
  else if (action == "log") return readLog(repo.get(), std::clamp(args.number("limit", 100), 1, 500));
  else if (action == "fetch") fetchRepository(repo.get(), op, args.boolean("unshallow"), args.boolean("prune"));
  else if (action == "checkout") checkoutCommit(repo.get(), args.string("commit"), op, true, false);
  else if (action == "update") {
    setRemote(repo.get(), args.string("url"));
    fetchRepository(repo.get(), op, false, false, args.string("branch"), true);
    git_oid oid{}; check(git_reference_name_to_id(&oid, repo.get(), "FETCH_HEAD"));
    checkoutCommit(repo.get(), oidString(&oid), op, false, true);
  } else throw std::runtime_error("Unknown native Git operation: " + action);
  return "{\"ok\":true}";
}
} // namespace

extern "C" JNIEXPORT void JNICALL Java_com_karinjs_karin_KarinGitNative_configure(JNIEnv* env, jobject, jstring caFile) {
  try {
    std::lock_guard<std::mutex> lock(initMutex);
    if (initialized) return;
    const auto ca = nativeString(env, caFile);
    if (ca.empty()) throw std::runtime_error("Git HTTPS CA certificate bundle is missing");
    check(git_libgit2_init());
    if (!(git_libgit2_features() & GIT_FEATURE_HTTPS)) throw std::runtime_error("libgit2 必须启用 HTTPS 支持");
    check(git_libgit2_opts(GIT_OPT_SET_SSL_CERT_LOCATIONS, ca.c_str(), nullptr));
    check(git_libgit2_opts(GIT_OPT_SET_SERVER_CONNECT_TIMEOUT, 15000));
    check(git_libgit2_opts(GIT_OPT_SET_SERVER_TIMEOUT, 30000));
    initialized = true;
  } catch (const std::exception& error) { fail(env, error); }
}
extern "C" JNIEXPORT jstring JNICALL Java_com_karinjs_karin_KarinGitNative_execute(JNIEnv* env, jobject, jstring action, jstring path, jstring options, jstring id, jobject callback) {
  try {
    { std::lock_guard<std::mutex> lock(initMutex); if (!initialized) throw std::runtime_error("Git native service has not been configured"); }
    Options args(env, options); Operation operation(env, callback, nativeString(env, id));
    return javaString(env, execute(nativeString(env, action), fs::path(nativeString(env, path)), args, operation));
  } catch (const std::exception& error) { fail(env, error); return nullptr; }
}
extern "C" JNIEXPORT jboolean JNICALL Java_com_karinjs_karin_KarinGitNative_cancel(JNIEnv* env, jobject, jstring id) {
  try {
    std::lock_guard<std::mutex> lock(operationsMutex);
    auto found = operations.find(nativeString(env, id));
    if (found == operations.end()) return JNI_FALSE;
    found->second->store(true); return JNI_TRUE;
  } catch (const std::exception& error) { fail(env, error); return JNI_FALSE; }
}
