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
import java.io.File

/**
 * 从系统文件选择器挑一个文件，复制进容器 rootfs 下 JS 指定的相对目录（app 插件用 karin-plugin-example）。
 * 目录规则留在 JS 那层，这里只负责「选文件 + 落地 + 回报文件名和大小」。
 */
class AppPluginImportModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  private var pending: Promise? = null
  private var pendingDir: String? = null

  private companion object {
    const val REQUEST_CODE = 0x4B11
    /** 兜底上限：app 插件就是几十 KB 的 js，这么大基本是选错文件了 */
    const val MAX_BYTES = 8L * 1024 * 1024
  }

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName() = "KarinAppPluginImport"

  @ReactMethod
  fun pickFile(relativeDir: String, promise: Promise) {
    if (pending != null) {
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
      promise.reject("IMPORT_FAILED", error)
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_CODE) return
    val promise = pending ?: return
    val relativeDir = pendingDir
    pending = null
    pendingDir = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null || relativeDir == null) {
      // 用户取消：回 null，由 JS 决定怎么处理
      promise.resolve(null)
      return
    }
    // 复制可能几百 KB，放到后台线程，别卡住 UI
    Thread {
      try {
        promise.resolve(copyIntoContainer(relativeDir, uri))
      } catch (error: Exception) {
        promise.reject("IMPORT_FAILED", error)
      }
    }.apply { isDaemon = true; name = "karin-plugin-import" }.start()
  }

  override fun onNewIntent(intent: Intent) = Unit

  private fun copyIntoContainer(relativeDir: String, uri: Uri): WritableMap {
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
    reactContext.contentResolver.openInputStream(uri)?.use { input ->
      file.outputStream().use { output -> input.copyTo(output) }
    } ?: throw IllegalStateException("无法读取所选文件")
    if (file.length() > MAX_BYTES) {
      file.delete()
      throw IllegalStateException("文件超过 8MB，app 插件一般是几十 KB 的 js")
    }
    return Arguments.createMap().apply {
      putString("name", name)
      putDouble("size", file.length().toDouble())
    }
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
