package com.karinjs.karin

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import org.json.JSONObject

/**
 * 系统文件导入：单个 APP 插件文件复制到指定目录；ZIP 插件校验根 package.json 后按 name 解压。
 * ZIP 任务固定所选压缩包内容，支持取消、限额校验与保留旧目录的覆盖提交。
 */
class AppPluginImportModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  private var pending: Promise? = null
  private var pendingDir: String? = null
  private var pendingTaskId: String? = null
  private var pendingArchive: Promise? = null
  private val archiveTasks = ConcurrentHashMap<String, ArchiveTask>()

  private class ArchiveTask {
    val cancelled = AtomicBoolean(false)
    val committing = Any()
    val sourceLock = Any()
    var committed = false
    var archive: File? = null
    var sourceUri: String? = null
  }

  private companion object {
    const val REQUEST_CODE = 0x4B11
    const val ARCHIVE_REQUEST_CODE = 0x4B12
    /** 兜底上限：app 插件就是几十 KB 的 js，这么大基本是选错文件了 */
    const val MAX_BYTES = 8L * 1024 * 1024
    const val MAX_ARCHIVE_BYTES = 64L * 1024 * 1024
    const val MAX_PACKAGE_JSON_BYTES = 1024L * 1024
    const val MAX_EXPANDED_BYTES = 256L * 1024 * 1024
    const val MAX_ARCHIVE_ENTRIES = 20000
  }

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName() = "KarinAppPluginImport"

  @ReactMethod
  fun pickFile(relativeDir: String, promise: Promise) = openFilePicker(relativeDir, null, promise)

  @ReactMethod
  fun pickFileCancellable(relativeDir: String, taskId: String, promise: Promise) {
    archiveTask(taskId)
    openFilePicker(relativeDir, taskId, promise)
  }

  private fun openFilePicker(relativeDir: String, taskId: String?, promise: Promise) {
    if (pending != null || pendingArchive != null) {
      promise.reject("IMPORT_BUSY", "已经有一个导入任务在进行")
      return
    }
    // RN 0.87 起 getCurrentActivity() 已废弃（Kotlin 侧也不再是属性），改从 ReactContext 取
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("IMPORT_NO_ACTIVITY", "应用不在前台，无法打开文件选择器")
      return
    }
    pending = promise
    pendingDir = relativeDir
    pendingTaskId = taskId
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(
        Intent.EXTRA_MIME_TYPES,
        arrayOf("text/javascript", "application/javascript", "text/plain", "application/octet-stream"),
      )
    }
    try {
      activity.startActivityForResult(intent, REQUEST_CODE)
    } catch (error: Exception) {
      pending = null
      pendingDir = null
      pendingTaskId = null
      promise.reject("IMPORT_FAILED", error)
    }
  }

  /** 打开系统选择器，选择一个 Karin 插件 zip。实际校验由 inspectArchive 完成。 */
  @ReactMethod
  fun pickArchive(promise: Promise) {
    if (pending != null || pendingArchive != null) {
      promise.reject("IMPORT_BUSY", "已经有一个导入任务在进行")
      return
    }
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("IMPORT_NO_ACTIVITY", "应用不在前台，无法打开文件选择器")
      return
    }
    pendingArchive = promise
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "application/zip"
      putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"))
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    }
    try {
      activity.startActivityForResult(intent, ARCHIVE_REQUEST_CODE)
    } catch (error: Exception) {
      pendingArchive = null
      promise.reject("IMPORT_FAILED", error)
    }
  }

  /** 只读取 zip 根目录 package.json，返回规范化后的目录名和重复警告。 */
  @ReactMethod
  fun inspectArchive(uriString: String, taskId: String, promise: Promise) {
    runAsync(promise, "IMPORT_INSPECT_FAILED") {
      val task = archiveTask(taskId)
      withArchive(uriString, task) { archive -> inspectArchiveFile(archive, task) }
    }
  }

  /** 将已校验的 zip 解压到 /root/karin/plugins/<package-name>。 */
  @ReactMethod
  fun importArchive(uriString: String, overwrite: Boolean, taskId: String, promise: Promise) {
    runAsync(promise, "IMPORT_FAILED") {
      val task = archiveTask(taskId)
      withArchive(uriString, task) { archive -> extractArchive(archive, overwrite, task) }
    }
  }

  /** 已进入最终目录替换时不再接受取消；此前的取消不会触碰旧插件。 */
  @ReactMethod
  fun cancelImport(taskId: String, promise: Promise) {
    val task = archiveTask(taskId)
    synchronized(task.committing) {
      if (task.committed) promise.resolve(false)
      else {
        task.cancelled.set(true)
        promise.resolve(true)
      }
    }
  }

  /** JS 在成功、失败、取消或拒绝覆盖后的 finally 中释放任务。 */
  @ReactMethod
  fun finishImport(taskId: String, promise: Promise) {
    runAsync(promise, "IMPORT_CLEANUP_FAILED") {
      val task = archiveTasks[taskId]
      if (task != null) {
        synchronized(task.committing) {
          if (!task.committed) task.cancelled.set(true)
        }
        synchronized(task.sourceLock) {
          task.archive?.delete()
          task.archive = null
          archiveTasks.remove(taskId, task)
        }
      }
      true
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode == ARCHIVE_REQUEST_CODE) {
      val archivePromise = pendingArchive ?: return
      pendingArchive = null
      val uri = data?.data
      if (resultCode != Activity.RESULT_OK || uri == null) {
        archivePromise.resolve(null)
        return
      }
      try {
        reactContext.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      } catch (_: Exception) { /* 某些文件提供器不支持持久授权，当前进程内仍可读取 */ }
      archivePromise.resolve(uri.toString())
      return
    }
    if (requestCode != REQUEST_CODE) return
    val promise = pending ?: return
    val relativeDir = pendingDir
    val taskId = pendingTaskId
    pending = null
    pendingDir = null
    pendingTaskId = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null || relativeDir == null) {
      // 用户取消：回 null，由 JS 决定怎么处理
      promise.resolve(null)
      return
    }
    // 复制可能几百 KB，放到后台线程，别卡住 UI
    Thread {
      try {
        promise.resolve(copyIntoContainer(relativeDir, uri, taskId?.let { archiveTask(it) } ?: ArchiveTask()))
      } catch (error: Exception) {
        promise.reject(if (error is CancellationException) "IMPORT_CANCELLED" else "IMPORT_FAILED", error)
      }
    }.apply { isDaemon = true; name = "karin-plugin-import" }.start()
  }

  override fun onNewIntent(intent: Intent) = Unit

  private fun copyIntoContainer(relativeDir: String, uri: Uri, task: ArchiveTask): WritableMap {
    checkCancelled(task)
    val root = RootfsInstaller(reactContext).rootDir().canonicalFile
    val dir = File(root, relativeDir).canonicalFile
    if (dir != root && !dir.path.startsWith(root.path + File.separator)) {
      throw IllegalStateException("目标目录不合法：$relativeDir")
    }
    val name = displayName(uri)
    if (name.isBlank()) throw IllegalStateException("取不到文件名，请换一个文件再试")
    val reported = sizeOf(uri)
    if (reported > MAX_BYTES) throw IllegalStateException("文件超过 8MB，app 插件一般是几十 KB 的 js")
    if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("无法创建目录：$relativeDir")
    val file = File(dir, name)
    val staging = File(dir, ".karin-file-import-${UUID.randomUUID()}")
    val backup = File(dir, ".karin-file-backup-${UUID.randomUUID()}")
    try {
      reactContext.contentResolver.openInputStream(uri)?.use { input ->
        staging.outputStream().use { output -> copyChecked(input, output, MAX_BYTES, task, "文件超过 8MB，app 插件一般是几十 KB 的 js") }
      } ?: throw IllegalStateException("无法读取所选文件")
      synchronized(task.committing) {
        checkCancelled(task)
        if (file.canonicalFile != file || Files.isSymbolicLink(file.toPath()) || file.isDirectory) {
          throw IllegalArgumentException("目标文件不合法或指向符号链接：$name")
        }
        var savedOriginal = false
        try {
          if (file.exists()) {
            if (!file.renameTo(backup)) throw IOException("无法保留原文件：$name")
            savedOriginal = true
          }
          if (!staging.renameTo(file)) throw IOException("无法写入插件文件：$name")
          task.committed = true
        } catch (error: Exception) {
          if (savedOriginal && !backup.renameTo(file)) throw IOException("导入失败，原文件保留在 ${backup.name}", error)
          throw error
        }
      }
      backup.delete()
    } finally {
      staging.delete()
    }
    return Arguments.createMap().apply {
      putString("name", name)
      putDouble("size", file.length().toDouble())
    }
  }

  private fun archiveTask(taskId: String): ArchiveTask {
    require(taskId.isNotBlank()) { "导入任务缺少 taskId" }
    return archiveTasks.getOrPut(taskId) { ArchiveTask() }
  }

  private fun checkCancelled(task: ArchiveTask) {
    if (task.cancelled.get()) throw CancellationException("任务已终止")
  }

  /** 所有输入流都使用有上限、可取消的分块读取，不能信任内容提供器或 zip 头声明的长度。 */
  private fun copyChecked(input: InputStream, output: OutputStream, limit: Long, task: ArchiveTask, message: String): Long {
    var copied = 0L
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    while (true) {
      checkCancelled(task)
      val read = input.read(buffer)
      checkCancelled(task)
      if (read < 0) break
      copied += read
      if (copied > limit) throw IllegalArgumentException(message)
      output.write(buffer, 0, read)
    }
    return copied
  }

  private fun <T> withArchive(uriString: String, task: ArchiveTask, action: (File) -> T): T {
    synchronized(task.sourceLock) {
      checkCancelled(task)
      if (task.sourceUri != null && task.sourceUri != uriString) throw IllegalArgumentException("导入任务的压缩包已改变，请重新选择")
      val cached = task.archive
      if (cached != null) return action(cached)
      val uri = Uri.parse(uriString)
      val temp = File(reactContext.cacheDir, "karin-plugin-${UUID.randomUUID()}.zip")
      try {
        val reported = sizeOf(uri)
        if (reported > MAX_ARCHIVE_BYTES) throw IllegalStateException("插件压缩包超过 64MB")
        reactContext.contentResolver.openInputStream(uri)?.use { input ->
          FileOutputStream(temp).use { output ->
            copyChecked(input, output, MAX_ARCHIVE_BYTES, task, "插件压缩包超过 64MB")
          }
        } ?: throw IllegalStateException("无法读取所选压缩包")
        checkCancelled(task)
        // 将确认覆盖时校验过的字节固定下来，后续 import 不再重读可能变化的内容提供器。
        task.sourceUri = uriString
        task.archive = temp
      } catch (error: Exception) {
        temp.delete()
        throw error
      }
      return action(temp)
    }
  }

  private fun inspectArchiveFile(archive: File, task: ArchiveTask): WritableMap {
    ZipFile(archive).use { zip ->
      val entries = validatedEntries(zip, task)
      val entry = entries.firstOrNull { it.first == "package.json" }?.second
        ?: throw IllegalArgumentException("压缩包根目录必须包含 package.json")
      if (entry.isDirectory) throw IllegalArgumentException("package.json 必须是文件")
      if (entry.size > MAX_PACKAGE_JSON_BYTES) throw IllegalArgumentException("package.json 超过 1MB")
      val buffer = ByteArrayOutputStream()
      zip.getInputStream(entry).use { input -> copyChecked(input, buffer, MAX_PACKAGE_JSON_BYTES, task, "package.json 超过 1MB") }
      val text = buffer.toString(Charsets.UTF_8.name()).trimStart('\uFEFF')
      val packageJson = try { JSONObject(text) }
        catch (_: Exception) { throw IllegalArgumentException("package.json 不是合法的 JSON") }
      val name = (packageJson.opt("name") as? String)?.trim() ?: throw IllegalArgumentException("package.json 缺少有效的 name")
      val directoryName = normalizePluginDirectory(name)
      val root = RootfsInstaller(reactContext).rootDir().canonicalFile
      val target = safePluginTarget(root, directoryName)
      val conflict = hasPluginConflict(target)
      checkCancelled(task)
      return Arguments.createMap().apply {
        putString("name", name)
        putString("directoryName", directoryName)
        putBoolean("conflict", conflict)
        if (conflict) putString("warning", "插件目录已存在且不为空")
        putDouble("size", archive.length().toDouble())
      }
    }
  }

  private fun extractArchive(archive: File, overwrite: Boolean, task: ArchiveTask): WritableMap {
    val infoMap = inspectArchiveFile(archive, task)
    val name = infoMap.getString("name") ?: throw IllegalArgumentException("package.json 缺少 name")
    val directoryName = infoMap.getString("directoryName") ?: throw IllegalArgumentException("插件目录名无效")
    // 启动流程负责初始化容器；导入不应在终止时仍继续进行完整 rootfs 解包。
    val root = RootfsInstaller(reactContext).rootDir().canonicalFile
    if (!File(root, "root/karin/package.json").isFile) throw IllegalStateException("Karin 环境尚未就绪")
    val plugins = safePluginsDirectory(root)
    if (!plugins.exists() && !plugins.mkdirs()) throw IOException("无法创建 plugins 目录")
    val target = safePluginTarget(root, directoryName)
    val conflict = hasPluginConflict(target)
    if (conflict && !overwrite) throw IllegalStateException("插件已存在：$directoryName")
    val staging = File(plugins, ".${directoryName}.karin-import-${UUID.randomUUID()}")
    val backup = File(plugins, ".${directoryName}.karin-backup-${UUID.randomUUID()}")
    checkCancelled(task)
    if (!staging.mkdirs()) throw IOException("无法创建插件临时目录")
    try {
      ZipFile(archive).use { zip ->
        var expandedBytes = 0L
        validatedEntries(zip, task).forEach { (relative, entry) ->
          checkCancelled(task)
          val destination = File(staging, relative).canonicalFile
          if (!destination.path.startsWith(staging.canonicalPath + File.separator)) throw IllegalArgumentException("压缩包包含非法路径：${entry.name}")
          if (entry.isDirectory) {
            if (!destination.isDirectory && !destination.mkdirs()) throw IOException("无法创建插件目录：$relative")
          } else {
            val parent = destination.parentFile ?: throw IOException("文件路径无效：$relative")
            if (!parent.isDirectory && !parent.mkdirs()) throw IOException("无法创建插件目录：$relative")
            zip.getInputStream(entry).use { input ->
              destination.outputStream().use { output ->
                expandedBytes += copyChecked(input, output, MAX_EXPANDED_BYTES - expandedBytes, task, "插件解压后超过 256MB")
              }
            }
          }
        }
      }
      synchronized(task.committing) {
        checkCancelled(task)
        // 重新检查目标，避免校验到替换间用户/容器改了路径或出现同名目录。
        safePluginTarget(root, directoryName)
        if (hasPluginConflict(target) && !overwrite) throw IllegalStateException("插件已存在：$directoryName")
        var savedOriginal = false
        try {
          if (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            if (!target.renameTo(backup)) throw IOException("无法保留旧插件目录：$directoryName")
            savedOriginal = true
          }
          if (!staging.renameTo(target)) throw IOException("无法写入插件目录：$directoryName")
          task.committed = true
        } catch (error: Exception) {
          if (savedOriginal && !backup.renameTo(target)) {
            throw IOException("导入失败，旧插件保留在 ${backup.name}，恢复目录失败：${error.message}", error)
          }
          throw error
        }
      }
      // 提交之后只清理保留的旧目录；取消不会在该阶段打断并留下半个插件。
      if (backup.exists()) deleteTreeWithoutFollowingLinks(backup)
      return Arguments.createMap().apply {
        putString("name", name)
        putString("directoryName", directoryName)
        putBoolean("overwritten", conflict)
      }
    } catch (error: Exception) {
      deleteTreeWithoutFollowingLinks(staging)
      throw error
    }
  }

  private fun normalizePluginDirectory(name: String): String {
    val valid = Regex("^karin-plugin-[A-Za-z0-9_.-]+$", RegexOption.IGNORE_CASE).matches(name) ||
      Regex("^@[A-Za-z0-9_.-]+/karin-plugin-[A-Za-z0-9_.-]+$", RegexOption.IGNORE_CASE).matches(name)
    if (!valid) throw IllegalArgumentException("package.json 的 name 必须是 karin-plugin-* 或 @scope/karin-plugin-*")
    val directory = name.substringAfter('/', name)
    if (directory.equals("karin-plugin-example", true) || directory.equals("karin-plugin-examplee", true)) {
      throw IllegalArgumentException("$directory 不允许作为压缩包插件导入")
    }
    return directory
  }

  private fun safePluginsDirectory(root: File): File {
    var directory = root
    for (segment in listOf("root", "karin", "plugins")) {
      directory = File(directory, segment).absoluteFile
      if (Files.isSymbolicLink(directory.toPath()) || directory.canonicalFile != directory) {
        throw IllegalArgumentException("插件路径不能是符号链接：$segment")
      }
      if (directory.exists() && !directory.isDirectory) throw IllegalArgumentException("插件路径不是目录：$segment")
    }
    return directory
  }

  private fun safePluginTarget(root: File, directoryName: String): File {
    val plugins = safePluginsDirectory(root)
    val target = File(plugins, directoryName).absoluteFile
    if (Files.isSymbolicLink(target.toPath()) || target.canonicalFile != target || target.parentFile != plugins) {
      throw IllegalArgumentException("插件目标目录不合法或指向符号链接：$directoryName")
    }
    return target
  }

  private fun hasPluginConflict(target: File): Boolean {
    if (!Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) return false
    if (!target.isDirectory) return true
    val children = target.list() ?: throw IOException("无法读取已有插件目录：${target.name}")
    return children.isNotEmpty()
  }

  private fun validatedEntries(zip: ZipFile, task: ArchiveTask): List<Pair<String, ZipEntry>> {
    val entries = mutableListOf<Pair<String, ZipEntry>>()
    val paths = HashSet<String>()
    var declaredBytes = 0L
    var count = 0
    val iterator = zip.entries()
    while (iterator.hasMoreElements()) {
      checkCancelled(task)
      val entry = iterator.nextElement()
      count++
      if (count > MAX_ARCHIVE_ENTRIES) throw IllegalArgumentException("压缩包条目超过 20000 个")
      val relative = safeZipPath(if (entry.isDirectory) entry.name.trimEnd('/') else entry.name)
      if (!paths.add(relative)) throw IllegalArgumentException("压缩包包含重复路径：$relative")
      if (!entry.isDirectory && entry.size > 0) {
        if (entry.size > MAX_EXPANDED_BYTES - declaredBytes) throw IllegalArgumentException("插件解压后超过 256MB")
        declaredBytes += entry.size
      }
      entries.add(relative to entry)
    }
    return entries
  }

  private fun safeZipPath(raw: String): String {
    val normalized = raw.replace('\\', '/')
    val parts = normalized.split('/')
    if (normalized.startsWith('/') || '\u0000' in normalized || ':' in normalized || parts.any { it.isEmpty() || it == "." || it == ".." }) {
      throw IllegalArgumentException("压缩包包含非法路径：$raw")
    }
    return parts.joinToString("/")
  }

  /** 原插件内部可能有 pnpm 的符号链接；清理备份时只删链接本身，绝不遍历链接目标。 */
  private fun deleteTreeWithoutFollowingLinks(file: File): Boolean {
    return try {
      if (!Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)) true
      else if (Files.isSymbolicLink(file.toPath()) || !file.isDirectory) Files.deleteIfExists(file.toPath())
      else {
        val children = file.listFiles() ?: return false
        var deleted = true
        for (child in children) if (!deleteTreeWithoutFollowingLinks(child)) deleted = false
        if (deleted) Files.deleteIfExists(file.toPath()) else false
      }
    } catch (_: Exception) { false }
  }

  private fun <T> runAsync(promise: Promise, code: String, action: () -> T) {
    Thread {
      try { promise.resolve(action()) }
      catch (error: Exception) { promise.reject(if (error is CancellationException) "IMPORT_CANCELLED" else code, error) }
    }.apply { isDaemon = true; name = "karin-plugin-import" }.start()
  }

  /** 只取文件名本身，避免 URi 自带的路径片段拼出目录穿越 */
  private fun displayName(uri: Uri): String {
    reactContext.contentResolver
      .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { cursor ->
        if (cursor.moveToFirst()) {
          val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (index >= 0) {
            val value = cursor.getString(index)
            if (!value.isNullOrBlank()) return File(value).name
          }
        }
      }
    return uri.lastPathSegment?.let { File(it).name } ?: ""
  }

  private fun sizeOf(uri: Uri): Long {
    reactContext.contentResolver
      .query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
      ?.use { cursor ->
        if (cursor.moveToFirst()) {
          val index = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (index >= 0 && !cursor.isNull(index)) return cursor.getLong(index)
        }
      }
    return -1L
  }
}
