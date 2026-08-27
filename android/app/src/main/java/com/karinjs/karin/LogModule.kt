package com.karinjs.karin

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 将启动日志保存到公共 Download 目录（karin-yyyyMMdd_HHmm.log），并提供打开保存位置的能力。
 * Android 10+ 使用 MediaStore 写入公共目录，无需存储权限；旧版本退回应用专属外部目录。
 */
class LogModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  override fun getName() = "KarinLog"

  private var latestLogFileName: String? = null

  /** 保存启动日志，返回用于展示的路径。 */
  @ReactMethod
  fun saveStartupLog(content: String, promise: Promise) {
    try {
      val path = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        saveViaMediaStore(content)
      } else {
        saveLegacy(content)
      }
      promise.resolve(path)
    } catch (error: Exception) {
      promise.reject("LOG_SAVE_FAILED", error)
    }
  }

  /** 打开日志文件所在位置：依次尝试文件管理器、系统下载列表，最后直接打开日志文件。 */
  @ReactMethod
  fun openLogLocation(promise: Promise) {
    try {
      var opened = openDownloadFolder()
      if (!opened) opened = openDownloadsApp()
      if (!opened && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        opened = openLogFile()
      }
      if (!opened) {
        promise.reject("LOG_OPEN_FAILED", IllegalStateException("没有可用的文件管理器"))
      } else {
        promise.resolve(true)
      }
    } catch (error: Exception) {
      promise.reject("LOG_OPEN_FAILED", error)
    }
  }

  private fun saveViaMediaStore(content: String): String {
    val resolver = context.contentResolver
    val fileName = newLogFileName()
    latestLogFileName = fileName
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
      // 用 octet-stream 避免系统按 text/plain 强制追加 .txt 后缀
      put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
      put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("无法在公共 Download 目录创建日志文件")
    try {
      resolver.openOutputStream(uri)?.use { output ->
        output.write(content.toByteArray(Charsets.UTF_8))
      } ?: throw IllegalStateException("无法写入日志文件")
    } catch (error: Exception) {
      resolver.delete(uri, null, null)
      throw error
    }
    resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
    latestLogFileName = queryDisplayName(uri) ?: fileName
    return displayPath()
  }

  /** 查询 MediaStore 实际落盘的文件名，防止系统改写后缀后展示的路径与真实文件不一致。 */
  private fun queryDisplayName(uri: Uri): String? {
    val projection = arrayOf(MediaStore.MediaColumns.DISPLAY_NAME)
    context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        return cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME))
      }
    }
    return null
  }

  private fun saveLegacy(content: String): String {
    val fileName = newLogFileName()
    latestLogFileName = fileName
    val fallback = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName)
    val publicFile = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), fileName)
    return try {
      publicFile.parentFile?.mkdirs()
      FileOutputStream(publicFile).use { it.write(content.toByteArray(Charsets.UTF_8)) }
      publicFile.absolutePath
    } catch (_: Exception) {
      fallback.parentFile?.mkdirs()
      FileOutputStream(fallback).use { it.write(content.toByteArray(Charsets.UTF_8)) }
      fallback.absolutePath
    }
  }

  private fun openDownloadFolder(): Boolean {
    val uri = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Download")
    val target = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, DocumentsContract.Document.MIME_TYPE_DIR)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    // 用系统“打开方式”选择器列出所有可浏览目录的应用（如各类文件管理器），避免直接跳转失败。
    return startActivity(Intent.createChooser(target, "选择文件管理器打开").apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    })
  }

  private fun openLogFile(): Boolean {
    val uri = queryLogFileUri() ?: return false
    return startActivity(Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "text/plain")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    })
  }

  /** 退回系统下载列表；部分 ROM 没有独立的下载应用时可能失败。 */
  private fun openDownloadsApp(): Boolean {
    return startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    })
  }

  private fun queryLogFileUri(): Uri? {
    val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
    val projection = arrayOf(MediaStore.MediaColumns._ID)
    val fileName = latestLogFileName ?: "karin-%"
    val selection = if (latestLogFileName == null) {
      "${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?"
    } else {
      "${MediaStore.MediaColumns.DISPLAY_NAME} = ?"
    }
    context.contentResolver.query(
      collection,
      projection,
      selection,
      arrayOf(fileName),
      "${MediaStore.MediaColumns.DATE_ADDED} DESC",
    )?.use { cursor ->
      if (cursor.moveToFirst()) {
        val id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID))
        return Uri.withAppendedPath(collection, id.toString())
      }
    }
    return null
  }

  private fun startActivity(intent: Intent): Boolean {
    return try {
      context.startActivity(intent)
      true
    } catch (_: ActivityNotFoundException) {
      false
    } catch (_: SecurityException) {
      false
    }
  }

  private fun displayPath(): String {
    val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
    return "${dir.absolutePath}/${latestLogFileName ?: "karin-unknown.log"}"
  }

  private fun newLogFileName(): String {
    val stamp = SimpleDateFormat("yyyyMMdd_HHmm", Locale.US).format(Date())
    return "karin-$stamp.log"
  }
}
