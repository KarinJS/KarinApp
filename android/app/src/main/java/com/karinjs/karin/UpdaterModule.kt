package com.karinjs.karin

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 应用自更新：把新版 APK 下载到应用私有目录（filesDir/updates），再交给系统安装器。
 *
 * 下载用 [HttpURLConnection] 自己实现（跟随重定向、边下边发进度事件、先写 .part 再改名，
 * 避免半截文件被当成完整安装包）；安装走 FileProvider 的 content:// URI，
 * Android 8+ 需要用户在系统设置里授予「安装未知应用」。
 */
class UpdaterModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  override fun getName() = "KarinUpdater"

  private fun updatesDir() = File(context.filesDir, UPDATE_DIR).apply { mkdirs() }
  private fun apkFile() = File(updatesDir(), APK_NAME)
  private fun partFile() = File(updatesDir(), "$APK_NAME.part")
  private fun metaFile() = File(updatesDir(), "$APK_NAME.part.txt")

  /** 断点续传信息：来源地址、服务器 ETag（续传时配 If-Range 用）与总大小。 */
  private data class PartialMeta(val url: String, val etag: String, val total: Long)

  /** 当前 App 版本（versionName/versionCode），供 JS 比较和展示。 */
  @ReactMethod
  fun getAppInfo(promise: Promise) {
    try {
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      promise.resolve(Arguments.createMap().apply {
        putString("versionName", info.versionName ?: "")
        putDouble("versionCode", packageVersionCode(info).toDouble())
      })
    } catch (error: Exception) {
      promise.reject("UPDATER_INFO_FAILED", error)
    }
  }

  /** 已下载安装包的信息（版本、大小、sha256）；不存在时返回 null。 */
  @ReactMethod
  @Suppress("DEPRECATION")
  fun inspectApk(promise: Promise) = runAsync(promise, "UPDATER_INSPECT_FAILED") {
    val file = apkFile()
    if (!file.isFile) return@runAsync null
    val info = context.packageManager.getPackageArchiveInfo(file.absolutePath, 0)
    Arguments.createMap().apply {
      putString("versionName", info?.versionName ?: "")
      putDouble("versionCode", packageVersionCode(info).toDouble())
      putDouble("size", file.length().toDouble())
      putString("sha256", sha256(file))
    }
  }

  /**
   * 未完成的下载信息（断点续传用）：已下载字节数、总大小与来源地址；没有半截文件时返回 null。
   */
  @ReactMethod
  fun inspectPartial(promise: Promise) = runAsync(promise, "UPDATER_PARTIAL_FAILED") {
    val part = partFile()
    val meta = readMeta()
    if (!part.isFile || meta == null || part.length() <= 0L) return@runAsync null
    Arguments.createMap().apply {
      putDouble("received", part.length().toDouble())
      putDouble("total", meta.total.toDouble())
      putString("url", meta.url)
    }
  }

  /**
   * 下载 APK 到私有目录，支持断点续传：半截文件与续传信息（地址 + ETag + 总大小）留在磁盘上，
   * 网络中断或进程被杀后再次调用会带 Range/If-Range 从断点继续；服务器不支持时自动从头下。
   * 进度通过 KarinUpdaterProgress 事件回传，完成后返回 sha256 与字节数。
   */
  @ReactMethod
  fun downloadApk(url: String, promise: Promise) = runAsync(promise, "UPDATER_DOWNLOAD_FAILED") {
    val target = apkFile()
    val part = partFile()
    /** 只有同地址、同 ETag 的半截文件才能续传，避免把两个版本的字节拼在一起 */
    val resumeMeta = readMeta()?.takeIf { it.url == url && it.etag.isNotEmpty() && it.total > 0L }
    val downloaded = if (part.isFile) part.length() else 0L
    if (resumeMeta != null && downloaded >= resumeMeta.total) {
      /** 上次已经下完、只差改名（例如改名瞬间被杀） */
      emitProgress(downloaded, resumeMeta.total)
      if (!part.renameTo(target)) throw IllegalStateException("无法写入安装包")
      deletePartialFiles()
      return@runAsync downloadResult(target)
    }
    val resuming = resumeMeta != null && downloaded > 0L
    if (!resuming) deletePartialFiles()
    val offset = if (resuming) downloaded else 0L
    var connection: HttpURLConnection? = null
    try {
      connection = connect(url, offset, if (resuming) resumeMeta?.etag ?: "" else "")
      val code = connection.responseCode
      if (code == HTTP_RANGE_NOT_SATISFIABLE) {
        /** 断点位置已经超出文件大小（例如服务器换了内容）：清掉半截包，下次从头下 */
        deletePartialFiles()
        throw IllegalStateException("断点已失效，已清理未完成的下载，请重试")
      }
      if (code !in 200..299) throw IllegalStateException("下载失败（HTTP $code）")
      /** 206 才能接着写；返回 200 说明服务器忽略/失效了 Range（含 If-Range 不匹配），必须从头下 */
      val append = code == 206 && offset > 0L
      val total = if (append) {
        parseContentRangeTotal(connection.getHeaderField("Content-Range")) ?: (resumeMeta?.total ?: 0L)
      } else {
        connection.contentLengthLong
      }
      var received = if (append) offset else 0L
      if (!append && part.exists() && !part.delete()) throw IllegalStateException("无法清理未完成的下载")
      val etag = connection.getHeaderField("ETag") ?: ""
      if (total > 0L && etag.isNotEmpty()) writeMeta(PartialMeta(url, etag, total)) else deletePartialFiles()
      emitProgress(received, total)
      var lastEmit = 0L
      val buffer = ByteArray(64 * 1024)
      connection.inputStream.use { input ->
        FileOutputStream(part, append).use { output ->
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            output.write(buffer, 0, read)
            received += read
            val now = System.currentTimeMillis()
            if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
              lastEmit = now
              emitProgress(received, total)
            }
          }
          output.flush()
        }
      }
      emitProgress(received, total)
      if (received <= 0L) throw IllegalStateException("下载内容为空")
      /** 没下满就报错，半截文件留在磁盘上供下次续传 */
      if (total > 0L && received < total) throw IllegalStateException("下载中断（$received/$total），可重试继续")
      if (target.exists() && !target.delete()) throw IllegalStateException("无法覆盖旧安装包")
      if (!part.renameTo(target)) throw IllegalStateException("无法写入安装包")
      deletePartialFiles()
      downloadResult(target)
    } finally {
      connection?.disconnect()
    }
  }

  /** 删除已下载内容：完整安装包 + 半截包 + 续传信息。 */
  @ReactMethod
  fun deleteApk(promise: Promise) = runAsync(promise, "UPDATER_DELETE_FAILED") {
    deletePartialFiles()
    val file = apkFile()
    !file.exists() || file.delete()
  }

  /**
   * 打开连接并手动跟随重定向：HttpURLConnection 的自动跳转不保证带上 Range/If-Range，
   * 而 GitHub Release 的下载地址一定会 302 到 CDN。
   */
  private fun connect(url: String, offset: Long, etag: String): HttpURLConnection {
    var current = url
    var hops = 0
    while (true) {
      val connection = (URL(current).openConnection() as HttpURLConnection).apply {
        connectTimeout = 20_000
        readTimeout = 30_000
        instanceFollowRedirects = false
        setRequestProperty("Accept", "application/octet-stream")
        setRequestProperty("User-Agent", "KarinApp-Updater")
        if (offset > 0L) {
          setRequestProperty("Range", "bytes=$offset-")
          if (etag.isNotEmpty()) setRequestProperty("If-Range", etag)
        }
      }
      val code = connection.responseCode
      if (code !in 300..399) return connection
      val location = connection.getHeaderField("Location")
      connection.disconnect()
      if (location.isNullOrEmpty() || ++hops > MAX_REDIRECTS) throw IllegalStateException("下载地址重定向异常（HTTP $code）")
      current = URL(URL(current), location).toString()
    }
  }

  /** Content-Range: bytes 100-999/1000 -> 1000 */
  private fun parseContentRangeTotal(value: String?): Long? {
    val total = value?.substringAfterLast('/')?.trim() ?: return null
    return total.takeIf { it.isNotEmpty() && it != "*" }?.toLongOrNull()
  }

  private fun downloadResult(file: File) = Arguments.createMap().apply {
    putDouble("size", file.length().toDouble())
    putString("sha256", sha256(file))
  }

  private fun readMeta(): PartialMeta? = try {
    val lines = metaFile().readLines()
    if (lines.size < 3) null else PartialMeta(lines[0], lines[1], lines[2].toLongOrNull() ?: 0L)
  } catch (_: Exception) {
    null
  }

  private fun writeMeta(meta: PartialMeta) {
    try {
      metaFile().writeText("${meta.url}\n${meta.etag}\n${meta.total}")
    } catch (_: Exception) {
      // 续传信息写不进去就退化成重新下载，不影响本次下载
    }
  }

  private fun deletePartialFiles() {
    partFile().delete()
    metaFile().delete()
  }

  /** 拉起系统安装器；未授予「安装未知应用」权限时返回 permission，由 JS 引导去设置。 */
  @ReactMethod
  fun installApk(promise: Promise) {
    try {
      val file = apkFile()
      if (!file.isFile) throw IllegalStateException("安装包不存在，请重新下载")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
        promise.resolve("permission")
        return
      }
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      context.startActivity(intent)
      promise.resolve("launched")
    } catch (error: ActivityNotFoundException) {
      promise.reject("UPDATER_INSTALL_FAILED", IllegalStateException("没有可用的安装器", error))
    } catch (error: Exception) {
      promise.reject("UPDATER_INSTALL_FAILED", error)
    }
  }

  /** 跳到「安装未知应用」授权页，用户可以手动允许本应用安装。 */
  @ReactMethod
  fun openInstallPermissionSettings(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        promise.resolve(false)
        return
      }
      context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
        data = Uri.parse("package:${context.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      })
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("UPDATER_SETTINGS_FAILED", error)
    }
  }

  @ReactMethod fun addListener(eventName: String) = Unit
  @ReactMethod fun removeListeners(count: Int) = Unit

  private fun emitProgress(received: Long, total: Long) {
    if (!context.hasActiveReactInstance()) return
    val event = Arguments.createMap().apply {
      putDouble("received", received.toDouble())
      putDouble("total", total.toDouble())
    }
    context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("KarinUpdaterProgress", event)
  }

  private fun appVersionCode(): Long = packageVersionCode(context.packageManager.getPackageInfo(context.packageName, 0))

  private fun packageVersionCode(info: PackageInfo?): Long {
    if (info == null) return 0L
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val read = input.read(buffer)
        if (read <= 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun <T> runAsync(promise: Promise, code: String, block: () -> T) {
    Thread { try { promise.resolve(block()) } catch (error: Exception) { promise.reject(code, error) } }
      .apply { isDaemon = true; name = "karin-updater" }.start()
  }

  private companion object {
    const val UPDATE_DIR = "updates"
    const val APK_NAME = "karin-update.apk"
    const val PROGRESS_INTERVAL_MS = 150L
    const val MAX_REDIRECTS = 5
    const val HTTP_RANGE_NOT_SATISFIABLE = 416
  }
}
