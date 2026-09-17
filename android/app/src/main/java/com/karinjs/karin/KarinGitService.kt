package com.karinjs.karin

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** Host-side libgit2 facade. Git paths are resolved into the extracted rootfs. */
internal class KarinGitService(private val context: Context) {
  private val rootfs = RootfsInstaller(context)
  private val operations = ConcurrentHashMap<String, Operation>()

  private class Operation(val cancelled: AtomicBoolean = AtomicBoolean(false))

  fun isAvailable(): Boolean = KarinGitNative.isAvailable()

  /** Reserve an operation before its worker is scheduled, closing cancel races. */
  fun reserveOperation(operationId: String): Boolean {
    if (operationId.isBlank()) return false
    return operations.putIfAbsent(operationId, Operation()) == null
  }

  fun finishOperation(operationId: String) {
    if (operationId.isNotBlank()) operations.remove(operationId)
  }

  fun requireAvailable() {
    KarinGitNative.requireAvailable()
    configure()
  }

  /** Configure libgit2's certificate bundle once per process. */
  fun configure() {
    if (configured) return
    synchronized(configureLock) {
      if (configured) return
      // Android's default trust anchors also work when the guest's CA bundle
      // or shell is damaged. Never disable libgit2's certificate verification.
      val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
        init(null as KeyStore?)
      }.trustManagers.filterIsInstance<X509TrustManager>().flatMap { it.acceptedIssuers.toList() }
      if (trust.isEmpty()) throw IllegalStateException("Android 信任证书列表为空")
      val directory = File(context.filesDir, "native-git").apply {
        if (!isDirectory && !mkdirs()) throw IllegalStateException("无法创建 Git 证书目录")
      }
      val bundle = File(directory, "ca-certificates.pem")
      val temporary = File(directory, "ca-certificates.pem.tmp")
      temporary.bufferedWriter().use { output ->
        trust.forEach { certificate ->
          output.appendLine("-----BEGIN CERTIFICATE-----")
          Base64.encodeToString(certificate.encoded, Base64.NO_WRAP).chunked(64).forEach { output.appendLine(it) }
          output.appendLine("-----END CERTIFICATE-----")
        }
      }
      if (!temporary.renameTo(bundle)) throw IllegalStateException("无法保存 Git 信任证书")
      KarinGitNative.configure(bundle.absolutePath)
      configured = true
    }
  }

  fun resolveGuest(path: String): File {
    val prefix = "/root/karin/plugins/"
    if (!path.startsWith(prefix) || path.indexOf('\u0000') >= 0 || path.contains('\\')) {
      throw IllegalArgumentException("Git 路径必须位于插件目录")
    }
    val relative = path.removePrefix(prefix)
    if (relative.split('/').any { it.isEmpty() || it == "." || it == ".." || it == ".git" }) {
      throw IllegalArgumentException("Git 插件路径无效")
    }
    val root = rootDirectory()
    val plugins = File(root, "root/karin/plugins")
    if (plugins.canonicalFile != plugins.absoluteFile) throw IllegalArgumentException("插件目录不能是符号链接")
    val requested = File(plugins, relative).absoluteFile
    val target = requested.canonicalFile
    if (target != requested || !target.toPath().startsWith(plugins.toPath()) || target == plugins) {
      throw IllegalArgumentException("Git 路径包含符号链接或越过插件目录")
    }
    validateGitDirectory(target)
    return target
  }

  fun resolveRepository(path: String): String {
    val directory = resolveGuest(path)
    if (!directory.isDirectory) throw IllegalArgumentException("Git 目录不存在：$path")
    return directory.absolutePath
  }

  fun isRepository(path: String): Boolean {
    requireAvailable()
    return objectResult("isRepository", resolveGuest(path).absolutePath, JSONObject())
      .optBoolean("isRepository", false)
  }

  fun pathState(path: String): String {
    requireAvailable()
    return objectResult("pathState", resolveGuest(path).absolutePath, JSONObject())
      .optString("state", "missing")
  }

  fun listRepositories(): String {
    requireAvailable()
    return executeRead("listRepositories", rootDirectory().canonicalPath, JSONObject())
  }

  fun isShallow(path: String): Boolean {
    requireAvailable()
    return objectResult("isShallow", resolveRepository(path), JSONObject())
      .optBoolean("shallow", false)
  }

  fun status(path: String, includeUntracked: Boolean): String {
    requireAvailable()
    return executeRead("status", resolveRepository(path), JSONObject().put("includeUntracked", includeUntracked))
  }

  fun log(path: String, limit: Int): String {
    requireAvailable()
    return executeRead("log", resolveRepository(path), JSONObject().put("limit", limit.coerceIn(1, 500)))
  }

  fun head(path: String): String {
    requireAvailable()
    return objectResult("head", resolveRepository(path), JSONObject()).optString("head", "")
  }

  fun remoteUrl(path: String): String {
    requireAvailable()
    return objectResult("remoteUrl", resolveRepository(path), JSONObject()).optString("url", "")
  }

  fun setRemoteUrl(path: String, url: String): String {
    requireAvailable()
    if (url.isBlank()) throw IllegalArgumentException("远程地址为空")
    return executeRead("setRemoteUrl", resolveRepository(path), JSONObject().put("url", url))
  }

  fun clone(url: String, destination: String, branch: String?, depth: Int, operationId: String,
    onProgress: (String) -> Unit = {}, cancelled: () -> Boolean = { false }): String {
    if (url.isBlank()) throw IllegalArgumentException("Git 仓库地址为空")
    return executeOperation(operationId, "clone", resolveGuest(destination).absolutePath,
      JSONObject().put("url", url).putOpt("branch", branch).put("depth", depth.coerceIn(0, 10_000)), onProgress, cancelled)
  }

  fun update(url: String, path: String, branch: String?, operationId: String,
    onProgress: (String) -> Unit = {}, cancelled: () -> Boolean = { false }): String {
    if (url.isBlank()) throw IllegalArgumentException("Git 仓库地址为空")
    return executeOperation(operationId, "update", resolveGuest(path).absolutePath,
      JSONObject().put("url", url).putOpt("branch", branch), onProgress, cancelled)
  }

  fun fetch(path: String, unshallow: Boolean, prune: Boolean, operationId: String,
    onProgress: (String) -> Unit = {}, cancelled: () -> Boolean = { false }): String =
    executeOperation(operationId, "fetch", resolveRepository(path),
      JSONObject().put("unshallow", unshallow).put("prune", prune), onProgress, cancelled)

  fun checkout(path: String, commit: String, operationId: String,
    onProgress: (String) -> Unit = {}, cancelled: () -> Boolean = { false }): String {
    if (!commit.matches(Regex("^[0-9a-fA-F]{40}$"))) throw IllegalArgumentException("提交哈希必须是完整 40 位 SHA-1")
    return executeOperation(operationId, "checkout", resolveRepository(path),
      JSONObject().put("commit", commit.lowercase()), onProgress, cancelled)
  }

  /** Clone and checkout in a sibling staging directory before replacing a backup target. */
  fun restore(url: String, path: String, branch: String?, commit: String, operationId: String,
    onProgress: (String) -> Unit = {}, cancelled: () -> Boolean = { false }): String {
    if (!commit.matches(Regex("^[0-9a-fA-F]{40}$"))) throw IllegalArgumentException("提交哈希必须是完整 40 位 SHA-1")
    if (url.isBlank()) throw IllegalArgumentException("Git 仓库地址为空")
    return executeOperation(operationId, "restore", resolveGuest(path).absolutePath,
      JSONObject().put("url", url).putOpt("branch", branch).put("commit", commit.lowercase()), onProgress, cancelled)
  }

  fun cancel(operationId: String): Boolean {
    if (operationId.isBlank()) return false
    val op = operations[operationId] ?: return false
    op.cancelled.set(true)
    runCatching { KarinGitNative.cancel(operationId) }
    return true
  }

  private fun executeRead(action: String, path: String, options: JSONObject): String {
    requireAvailable()
    return KarinGitNative.execute(action, path, options.toString(), null, null).ifBlank { "{}" }
  }

  private fun objectResult(action: String, path: String, options: JSONObject): JSONObject =
    JSONObject(executeRead(action, path, options))

  private fun executeOperation(operationId: String, action: String, path: String, options: JSONObject,
    onProgress: (String) -> Unit, cancelled: () -> Boolean): String {
    requireAvailable()
    val id = operationId.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("Git 操作 ID 为空")
    val operation = operations[id] ?: throw IllegalStateException("Git 操作未注册：$id")
    val callback = object : KarinGitNative.Callback {
      override fun onProgress(message: String) { if (message.isNotBlank()) onProgress(message) }
      override fun isCancelled(): Boolean = operation.cancelled.get() || cancelled()
    }
    return KarinGitNative.execute(action, path, options.toString(), id, callback)
  }

  private fun rootDirectory(): File {
    val root = rootfs.rootDir().canonicalFile
    if (!root.isDirectory) throw IllegalStateException("rootfs 尚未解包，无法访问插件目录")
    if (root != File(context.filesDir.canonicalFile, "debian-rootfs")) throw IllegalStateException("rootfs 目录不能是符号链接")
    return root
  }

  private fun validateGitDirectory(repository: File) {
    val dotGit = File(repository, ".git")
    if (dotGit.canonicalFile != dotGit.absoluteFile) throw IllegalArgumentException("Git 元数据目录不能是符号链接")
    if (dotGit.isFile) {
      if (dotGit.length() > 4096) throw IllegalArgumentException("Git 元数据指针过长")
      val value = dotGit.bufferedReader().use { it.readLine().orEmpty() }
      if (!value.startsWith("gitdir: ")) throw IllegalArgumentException("Git 元数据指针无效")
      val raw = value.removePrefix("gitdir: ").trim()
      if (raw.isEmpty() || raw.indexOf('\u0000') >= 0) throw IllegalArgumentException("Git 元数据指针无效")
      val gitDir = (if (File(raw).isAbsolute) File(raw) else File(repository, raw)).canonicalFile
      if (!gitDir.toPath().startsWith(repository.toPath())) throw IllegalArgumentException("Git 元数据不能指向插件目录外")
    }
    // External commondir/worktree metadata must not let host libgit2 touch
    // another plugin or app-private files; regular clones never need these.
    if (File(dotGit, "commondir").exists()) throw IllegalArgumentException("不支持共享 Git 元数据目录")
  }

  private companion object {
    @Volatile var configured = false
    val configureLock = Any()
  }

}
